import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GitHubError, githubClientFor, type GitHubClient } from "@/lib/github/client";
import { parseGitHubRepoUrl, type RepoRef } from "@/lib/github/pull-request-url";
import { previewSettingsValues } from "@/lib/validations/preview-settings";
import { MAIN_BRANCH_PULL_NUMBER, projectPreviewUrl } from "@/lib/previews/address";
import {
  RECHECK_MS,
  builderClient,
  dispatchPreviewBuild,
  findBuilderRun,
  oneLine,
  previewBuilder,
  type PreviewBuildView,
} from "@/lib/previews/builds";
import { changesForRun, viewStatus } from "@/lib/previews/run-outcome";

/**
 * Project previews (#project-previews): a project with previews on keeps one
 * live preview of its main branch, at one fixed address
 * (`projectPreviewUrl`, the builder's `pr-0-<repo id>` branch).
 *
 * Ziki checks each such project's main branch every few minutes (the cron
 * sweep) or when an admin presses Build now, and starts the same preview
 * builder as pull request previews (lib/previews/builds.ts) for each new
 * commit. One build per project and commit, recorded as a
 * `ProjectPreviewBuild`. A failed commit isn't retried on its own; the next
 * commit, or Build now, tries again.
 */

/** How often the sweep looks at one project's main branch. */
export const MAIN_CHECK_INTERVAL_MS = 5 * 60_000;

export type ProjectPreviewOutcome =
  | { outcome: "started" }
  | { outcome: "up_to_date" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

/** The repository's default branch and its latest commit, or null when GitHub won't say. */
async function mainHead(client: GitHubClient, repo: RepoRef): Promise<{ branch: string; sha: string } | null> {
  const info = await client.getOrNull<{ default_branch?: string }>(repoPath(repo));
  const branch = info?.default_branch;
  if (!branch) return null;
  const head = await client.getOrNull<{ sha?: string }>(`${repoPath(repo)}/commits/${encodeURIComponent(branch)}`);
  const sha = head?.sha?.toLowerCase();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  return { branch, sha };
}

/**
 * Build the project's main branch when it has a commit Ziki hasn't built yet.
 * `force` (Build now) skips the every-few-minutes wait and retries a commit
 * whose build failed. Never throws.
 */
export async function startProjectPreviewIfDue(projectId: string, options: { force?: boolean } = {}): Promise<ProjectPreviewOutcome> {
  try {
    const builder = previewBuilder();
    if (!builder) return { outcome: "skipped", reason: "Previews aren't set up on this server." };

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { repoUrl: true, githubInstallationId: true, archivedAt: true, previewSettings: true },
    });
    if (!project || project.archivedAt) return { outcome: "skipped", reason: "Project not found." };
    const settings = previewSettingsValues(project.previewSettings);
    if (!project.previewSettings || !settings.enabled) return { outcome: "skipped", reason: "Previews are off for this project." };
    const repo = parseGitHubRepoUrl(project.repoUrl);
    if (!repo) return { outcome: "skipped", reason: "The project has no GitHub repository." };

    const checkedAt = project.previewSettings.mainCheckedAt;
    if (!options.force && checkedAt && Date.now() - checkedAt.getTime() < MAIN_CHECK_INTERVAL_MS) {
      return { outcome: "up_to_date" };
    }
    await prisma.projectPreviewSettings.update({ where: { projectId }, data: { mainCheckedAt: new Date() } });

    let head: { branch: string; sha: string } | null;
    try {
      const client = await githubClientFor({ githubInstallationId: project.githubInstallationId });
      head = await mainHead(client, repo);
    } catch (error) {
      if (!(error instanceof GitHubError)) console.error("[project-previews] reading main failed", projectId, error);
      return { outcome: "failed", reason: "Ziki couldn't read the repository's main branch." };
    }
    if (!head) return { outcome: "failed", reason: "Ziki couldn't read the repository's main branch." };

    const existing = await prisma.projectPreviewBuild.findUnique({
      where: { projectId_headSha: { projectId, headSha: head.sha } },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status !== "failed" || !options.force) return { outcome: "up_to_date" };
      // Build now on a commit that failed: try it again.
      await prisma.projectPreviewBuild.delete({ where: { id: existing.id } });
    }

    const repository = `${repo.owner}/${repo.repo}`;
    let build: { id: string };
    try {
      build = await prisma.projectPreviewBuild.create({
        data: { projectId, repository, branch: head.branch, headSha: head.sha },
        select: { id: true },
      });
    } catch (error) {
      // Another check started this commit a moment ago.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { outcome: "up_to_date" };
      throw error;
    }

    try {
      const run = await dispatchPreviewBuild(builder, {
        buildId: build.id,
        repository,
        headSha: head.sha,
        pr: MAIN_BRANCH_PULL_NUMBER,
        settings,
      });
      if (run) {
        await prisma.projectPreviewBuild.update({
          where: { id: build.id },
          data: { status: "building", runId: run.runId, runUrl: run.runUrl },
        });
      }
      return { outcome: "started" };
    } catch (error) {
      if (!(error instanceof GitHubError)) console.error("[project-previews] dispatch failed", error);
      const reason = oneLine(error);
      await prisma.projectPreviewBuild.update({
        where: { id: build.id },
        data: { status: "failed", error: reason, completedAt: new Date() },
      });
      return { outcome: "failed", reason };
    }
  } catch (error) {
    console.error("[project-previews] start failed", projectId, error);
    return { outcome: "failed", reason: "Ziki couldn't start the preview." };
  }
}

/** Follow unfinished project builds (all, or one project's), a few at a time. */
export async function followProjectPreviewBuilds(
  options: { projectId?: string; limit?: number } = {},
): Promise<{ checked: number; failed: number }> {
  const builder = previewBuilder();
  if (!builder) return { checked: 0, failed: 0 };
  const builds = await prisma.projectPreviewBuild.findMany({
    where: {
      ...(options.projectId ? { projectId: options.projectId } : {}),
      status: { in: ["queued", "building"] },
      updatedAt: { lt: new Date(Date.now() - RECHECK_MS) },
    },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 20,
    select: { id: true, runId: true, repository: true, createdAt: true },
  });
  if (!builds.length) return { checked: 0, failed: 0 };
  let client: GitHubClient;
  try {
    client = await builderClient(builder);
  } catch (error) {
    if (!(error instanceof GitHubError)) console.error("[project-previews] builder access failed", error);
    return { checked: 0, failed: builds.length };
  }
  let failed = 0;
  for (const build of builds) {
    try {
      const run = await findBuilderRun(builder, client, build);
      await prisma.projectPreviewBuild.update({
        where: { id: build.id },
        data: changesForRun(run, build.createdAt, projectPreviewUrl(build.repository, builder.pagesProject)),
      });
    } catch (error) {
      failed++;
      if (!(error instanceof GitHubError)) console.error("[project-previews] follow failed", build.id, error);
    }
  }
  return { checked: builds.length, failed };
}

/** The cron sweep: check the main branch of projects with previews on, least recently checked first. */
export async function sweepProjectPreviews(options: { limit?: number } = {}): Promise<{ checked: number; started: number }> {
  if (!previewBuilder()) return { checked: 0, started: 0 };
  const due = await prisma.projectPreviewSettings.findMany({
    where: {
      enabled: true,
      project: { archivedAt: null, repoUrl: { not: null } },
      OR: [{ mainCheckedAt: null }, { mainCheckedAt: { lt: new Date(Date.now() - MAIN_CHECK_INTERVAL_MS) } }],
    },
    orderBy: { mainCheckedAt: { sort: "asc", nulls: "first" } },
    take: options.limit ?? 10,
    select: { projectId: true },
  });
  let started = 0;
  for (const { projectId } of due) {
    const result = await startProjectPreviewIfDue(projectId);
    if (result.outcome === "started") started++;
  }
  return { checked: due.length, started };
}

/** The latest main-branch build and the last working preview address, for the settings card. */
export async function latestProjectPreview(projectId: string): Promise<{ build: PreviewBuildView | null; lastReadyUrl: string | null }> {
  const [build, lastReady] = await Promise.all([
    prisma.projectPreviewBuild.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, headSha: true, url: true, runUrl: true, error: true, createdAt: true, completedAt: true },
    }),
    prisma.projectPreviewBuild.findFirst({
      where: { projectId, status: "ready" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { url: true },
    }),
  ]);
  return {
    build: build
      ? {
          id: build.id,
          status: viewStatus(build.status),
          headSha: build.headSha,
          url: build.url,
          runUrl: build.runUrl,
          error: build.error,
          createdAt: build.createdAt.toISOString(),
          completedAt: build.completedAt?.toISOString() ?? null,
        }
      : null,
    lastReadyUrl: lastReady?.url ?? null,
  };
}
