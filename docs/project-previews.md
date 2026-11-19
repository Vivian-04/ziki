# Project previews (#project-previews)

Every project with previews on keeps **one live preview of its main branch**, at
one fixed link, rebuilt after each merge. Admins see it in **Project settings →
Previews**, with a **Build now** button.

It reuses the pull request preview builder (#previews): same builder workflow,
same project preview settings, same Cloudflare Pages project. Pull request
previews keep working as before.

## How it works

1. **New commit on main.** The cron sweep (`sweepProjectPreviews`, in
   `lib/cron/runner.ts`) looks at each project with previews on, at most every
   5 minutes per project (`ProjectPreviewSettings.mainCheckedAt`). It reads the
   repository's default branch and its latest commit through the project's
   GitHub App installation.
2. **Build.** For a commit it hasn't built, Ziki records a
   `ProjectPreviewBuild` (one per project and commit) and starts the preview
   builder with the project's settings and `pr: 0`.
3. **Fixed link.** The builder deploys to the Pages branch `pr-0-<repo id>`,
   so the link (`projectPreviewUrl`) is the same for every commit:
   `https://pr-0-<repo id>.<pages project>.pages.dev`. Real pull requests start
   at 1, so it never clashes with a pull request's preview.
4. **Follow.** The sweep and the settings card follow the run, using the same
   rules as pull request previews (`lib/previews/run-outcome.ts`): building,
   ready, failed, or given up after 15 minutes without a run or 45 minutes
   running.
5. **Build now** checks straight away, and retries a commit whose build failed.
   The sweep never retries a failed commit on its own; the next commit does.

## Files

| File | What it does |
|---|---|
| `lib/previews/project-builds.ts` | Read main, start builds, follow them, the sweep, the latest build |
| `lib/previews/run-outcome.ts` | How a builder run maps to a build's status (shared with pull request previews) |
| `lib/previews/builds.ts` | Pull request previews; now exports the builder helpers both kinds use |
| `lib/previews/address.ts` | `projectPreviewUrl`: the fixed main-branch link |
| `app/(app)/projects/[slug]/settings/preview-actions.ts` | `projectPreviewStatusAction`, `buildProjectPreviewNowAction` (admins only) |
| `components/project-preview-card.tsx` | The Main branch preview card in Settings → Previews |
| `prisma/schema.prisma` | `ProjectPreviewBuild`, `ProjectPreviewSettings.mainCheckedAt` |

## Notes

- The builder must accept `pr: 0`. If it validates the pull request number as
  1 or more, allow 0 there.
- Static frontends only, like pull request previews. Apps that need a server
  and a database are a follow-up (Cloudflare Containers).
- The migration adds the table and column only. Prisma also proposes dropping
  the `*_trgm_idx` search indexes, which are created by hand in an earlier
  migration; those lines were removed and must stay out.
