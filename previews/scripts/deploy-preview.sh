#!/usr/bin/env bash
# Deploy (or update) one server preview.
#
#   ./scripts/deploy-preview.sh <owner/repo> <pr-number> <commit-sha> <image>
#
# Example:
#   ./scripts/deploy-preview.sh emerjent/ziki 712 3f9c1e... ghcr.io/emerjent/ziki-previews:abc-3f9c1e...
#
# Env:
#   PREVIEW_DOMAIN   e.g. preview.ziki.dev or 203-0-113-5.sslip.io
#   PREVIEW_HOST     or set the full host instead, e.g. abc-def.trycloudflare.com
#                    (one of the two is required)
#   PREVIEW_SCHEME   http (default) or https
#   GHCR_PULL_USER / GHCR_PULL_TOKEN   optional, for private images
#
# Running it again for a new commit updates the same preview in place
# (same URL, same database, same logins).
set -euo pipefail

REPO="${1:?owner/repo}"
PR="${2:?pr number}"
SHA="${3:?commit sha}"
IMAGE="${4:?image}"
TUNNEL="${PREVIEW_TUNNEL:-0}"
[[ "$TUNNEL" == "1" || -n "${PREVIEW_HOST:-}" || -n "${PREVIEW_DOMAIN:-}" ]] \
  || { echo "set PREVIEW_TUNNEL=1, PREVIEW_HOST or PREVIEW_DOMAIN"; exit 1; }
SCHEME="${PREVIEW_SCHEME:-http}"

# sha256sum on Linux, shasum on macOS.
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/../k8s/preview.template.yaml"

# Same naming as Ziki's lib/previews/address.ts:
#   pr-<number>-<first 10 hex of sha256(lowercase owner/name)>
REPO_LC="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
REPO_ID="$(printf '%s' "$REPO_LC" | sha256 | cut -c1-10)"
NS="pr-${PR}-${REPO_ID}"
echo "==> Preview ${NS} for ${REPO}#${PR} @ ${SHA:0:7}"

# 0. One preview at a time on a laptop (tunnel mode, or PREVIEW_MAX_ONE=1):
#    delete any other preview first so the laptop doesn't run out of memory.
if [[ "${PREVIEW_MAX_ONE:-$TUNNEL}" == "1" ]]; then
  for OTHER in $(kubectl get namespaces -l ziki.dev/preview=true -o jsonpath='{.items[*].metadata.name}'); do
    if [[ "$OTHER" != "$NS" ]]; then
      echo "    removing older preview ${OTHER} (one at a time)"
      kubectl delete namespace "$OTHER" --wait=true --timeout=120s || true
    fi
  done
fi

# 1. Namespace (idempotent) + labels used for cleanup.
kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"
kubectl label namespace "$NS" --overwrite \
  ziki.dev/preview=true \
  ziki.dev/pr="$PR" \
  ziki.dev/repo-id="$REPO_ID" \
  pod-security.kubernetes.io/enforce=restricted >/dev/null
kubectl annotate namespace "$NS" --overwrite \
  ziki.dev/repository="$REPO_LC" \
  ziki.dev/last-deployed="$(date -u +%s)" >/dev/null

# 2. Secrets: generated ONCE per preview. Regenerating them on every commit
#    would break the existing Postgres (it keeps its first password) and log
#    testers out.
if ! kubectl -n "$NS" get secret preview-secrets >/dev/null 2>&1; then
  PG_PASSWORD="$(openssl rand -hex 16)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=')"
  kubectl -n "$NS" create secret generic preview-secrets \
    --from-literal=PG_PASSWORD="$PG_PASSWORD" \
    --from-literal=DATABASE_URL="postgresql://ziki:${PG_PASSWORD}@postgres:5432/ziki?schema=public" \
    --from-literal=AUTH_SECRET="$(openssl rand -base64 32)" \
    --from-literal=SUPER_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    --from-literal=CRON_SECRET="$(openssl rand -hex 24)" >/dev/null
  echo "    created preview-secrets"
fi

# 3. Registry pull secret (only if creds were given).
if [[ -n "${GHCR_PULL_TOKEN:-}" ]]; then
  kubectl -n "$NS" create secret docker-registry ghcr-pull \
    --docker-server=ghcr.io \
    --docker-username="${GHCR_PULL_USER:?set GHCR_PULL_USER too}" \
    --docker-password="$GHCR_PULL_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

# 4. The public address.
#    PREVIEW_TUNNEL=1: start a quick tunnel inside the namespace and read the
#    https://<words>.trycloudflare.com address it prints. A new commit reuses
#    the same tunnel, so the link stays the same.
if [[ "$TUNNEL" == "1" ]]; then
  sed -e "s|\${NS}|${NS}|g" "$HERE/../k8s/tunnel.yaml" | kubectl apply -f - >/dev/null
  kubectl -n "$NS" rollout status deploy/tunnel --timeout=180s
  HOST=""
  for _ in $(seq 1 45); do
    HOST="$(kubectl -n "$NS" logs deploy/tunnel 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 | sed 's|https://||' || true)"
    [[ -n "$HOST" ]] && break
    sleep 2
  done
  [[ -n "$HOST" ]] || { echo "!! Tunnel gave no address. Logs:"; kubectl -n "$NS" logs deploy/tunnel --tail=50 || true; exit 1; }
  SCHEME=https
else
  HOST="${PREVIEW_HOST:-${NS}.${PREVIEW_DOMAIN:-}}"
fi
URL="${SCHEME}://${HOST}"
echo "    address: ${URL}"

# 5. Everything else. Only our five ${...} placeholders are replaced, so any
#    other "$" in the YAML is left alone. (sed, so no extra tools needed.)
for v in "$NS" "$HOST" "$IMAGE" "$SCHEME" "$SHA"; do
  [[ "$v" =~ ^[A-Za-z0-9._:/@-]+$ ]] || { echo "unsafe value: $v"; exit 1; }
done
sed -e "s|\${NS}|${NS}|g" \
    -e "s|\${HOST}|${HOST}|g" \
    -e "s|\${IMAGE}|${IMAGE}|g" \
    -e "s|\${SCHEME}|${SCHEME}|g" \
    -e "s|\${SHA}|${SHA}|g" \
    "$TEMPLATE" | kubectl apply -f -

# 6. Wait until it actually answers /api/health.
echo "==> Waiting for rollout"
if ! kubectl -n "$NS" rollout status deploy/postgres --timeout=180s \
  || ! kubectl -n "$NS" rollout status deploy/app --timeout=600s; then
  echo "!! Rollout failed. Last app logs:"
  kubectl -n "$NS" logs deploy/app --all-containers --tail=150 || true
  kubectl -n "$NS" get pods -o wide || true
  kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -20 || true
  exit 1
fi

# 7. A ready-made login. Ziki only creates accounts in its seed script, which
#    needs dev tools the app image doesn't have, so create the admin straight
#    in the preview's own database. Same bcrypt format Ziki checks passwords
#    with. Safe to run again: it just resets the same account.
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="$(kubectl -n "$NS" get secret preview-secrets -o jsonpath='{.data.SUPER_ADMIN_PASSWORD}' | base64 -d)"
echo "==> Creating the preview login"
kubectl -n "$NS" exec -i deploy/postgres -- \
  psql -v ON_ERROR_STOP=1 -q -U ziki -d ziki -v pw="$ADMIN_PASSWORD" -v em="$ADMIN_EMAIL" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO "User" (id, name, email, "passwordHash", role, "emailVerified")
VALUES ('preview-admin', 'Preview Admin', :'em', crypt(:'pw', gen_salt('bf', 12)), 'super_admin', now())
ON CONFLICT (email) DO UPDATE
  SET "passwordHash" = EXCLUDED."passwordHash", role = 'super_admin';
SQL

echo "==> Ready: ${URL}"
echo "    Sign in: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"

# Hand the details to GitHub Actions if we're running there.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "url=${URL}"
    echo "namespace=${NS}"
    echo "admin_email=${ADMIN_EMAIL}"
    echo "admin_password=${ADMIN_PASSWORD}"
  } >> "$GITHUB_OUTPUT"
fi
