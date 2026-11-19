import { createHash } from "node:crypto";

/**
 * Where a pull request's preview lives (#previews). Must match the preview
 * builder's deploy step (zedu-vulcan/ziki-preview-builder, preview.yml):
 *
 *   repo_id=$(printf '%s' "${REPOSITORY,,}" | sha256sum | cut -c1-10)
 *   branch="pr-$PR-$repo_id"
 *
 * Cloudflare Pages serves the branch's latest upload at
 * https://<branch>.<pages project>.pages.dev, so the address is known before
 * the build finishes and stays the same across new commits.
 */

export const DEFAULT_PAGES_PROJECT = "ziki-previews";

/** The Pages branch for `owner/name` pull request `pullNumber`. */
export function previewBranch(repository: string, pullNumber: number): string {
  const repoId = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 10);
  return `pr-${pullNumber}-${repoId}`;
}

/** The pull request's preview address. */
export function previewUrl(repository: string, pullNumber: number, pagesProject = DEFAULT_PAGES_PROJECT): string {
  return `https://${previewBranch(repository, pullNumber)}.${pagesProject}.pages.dev`;
}
/**
 * The pull request number a project's main-branch preview uses
 * (#project-previews). Real pull requests start at 1, so 0 can't clash with
 * one, and the builder's branch becomes `pr-0-<repo id>`: one fixed address
 * per repository, updated with each new main commit.
 */
export const MAIN_BRANCH_PULL_NUMBER = 0;

/** The address of the project's main-branch preview for `owner/name`. */
export function projectPreviewUrl(repository: string, pagesProject = DEFAULT_PAGES_PROJECT): string {
  return previewUrl(repository, MAIN_BRANCH_PULL_NUMBER, pagesProject);
}