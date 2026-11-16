#!/usr/bin/env bash
# Delete one preview (run when the PR is merged or closed).
#
#   ./scripts/destroy-preview.sh <owner/repo> <pr-number>
#
# Deleting the namespace deletes everything inside it: app, Postgres, data,
# secrets, URL.
set -euo pipefail

REPO="${1:?owner/repo}"
PR="${2:?pr number}"

REPO_LC="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
REPO_ID="$(printf '%s' "$REPO_LC" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | cut -c1-10)"
NS="pr-${PR}-${REPO_ID}"

# Only ever delete namespaces this system created.
if [[ "$(kubectl get namespace "$NS" -o jsonpath='{.metadata.labels.ziki\.dev/preview}' 2>/dev/null)" != "true" ]]; then
  echo "No preview namespace ${NS}; nothing to do."
  exit 0
fi

kubectl delete namespace "$NS" --wait=false
echo "Deleting ${NS}"
