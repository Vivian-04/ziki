# Automatic backend previews (demo on a local cluster)

Open a PR in this fork and it gets its own running copy of Ziki, with its own
database and a public link, posted as a comment on the PR. Close the PR and
it's deleted.

```
PR opened / new commit
  -> GitHub Actions builds the PR's Docker image (ghcr.io/<you>/ziki-previews)
  -> a self-hosted runner on my laptop deploys it to my local Kubernetes cluster:
       namespace pr-<n>-<id>
         app       the PR's image
         postgres  empty, deleted with the preview
         tunnel    public https link (Cloudflare quick tunnel, no account)
  -> the link is commented on the PR
PR closed -> namespace deleted -> comment says "Preview deleted"
```

## Files

| File | What it does |
|---|---|
| `.github/workflows/pr-preview.yml` | Build on GitHub, deploy and clean up on the laptop, comment on the PR |
| `previews/scripts/deploy-preview.sh` | Create or update one preview and wait until it's healthy |
| `previews/scripts/destroy-preview.sh` | Delete one preview |
| `previews/k8s/preview.template.yaml` | App, Postgres, limits and network rules for one preview |
| `previews/k8s/tunnel.yaml` | The public link for one preview |

## Safety

- Only PRs made inside this repo run. PRs from other people's forks never reach the laptop.
- Deploy scripts always come from `main`, never from the PR being previewed.
- Previews get generated passwords and their own database, never real secrets.

## Limits of this demo, and the next step

- It runs on my laptop, so previews only work while the laptop and runner are on.
- Quick-tunnel links are for demos; they change if the tunnel restarts.
- Next: run the same thing on Cloudflare Containers (or a server), and have Ziki
  trigger it from its existing preview system (PR #669) so the link shows on
  the Ziki issue.
