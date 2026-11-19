import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GitHubError, githubClientFor, installationIdForRepo, type GitHubClient } from "@/lib/github/client";
import { parseGitHubRepoUrl, parsePullRequestUrl, sameRepo, type RepoRef } from "@/lib/github/pull-request-url";
import { previewSettingsValues } from "@/lib/validations/preview-settings";
import { DEFAULT_PAGES_PROJECT, previewUrl } from "@/lib/previews/address";
import { changesForRun, runForBuild, viewStatus, type PreviewBuildStatus, type WorkflowRun } from "@/lib/previews/run-outcome";

/**
 * Pull request previews (#previews): Ziki builds each new commit of a pull
 * request in the project's main repository, when the project has previews on.
 *
 * Ziki doesn't build anything itself. It starts the preview builder, a GitHub
 * Actions workflow in Ziki's own repository (`PREVIEW_BUILDER_REPO`, through
 * the installation of Ziki's GitHub App there), with the project's settings as
 * the run's inputs. The builder builds the commit with no secrets and uploads
 * the output to Ziki's Cloudflare Pages project (`PREVIEW_PAGES_PROJECT`).
 * Ziki follows the run (when the issue page is open, on GitHub reads, and in
 * the cron sweep) and records the result as a `PreviewBuild`.
 *
 * A build starts when Ziki reads the pull request (lib/github/sync.ts) and
 * sees an open pull request at a commit it hasn't built for that issue: after
 * delivery, when GitHub's webhook says the branch moved, and when the issue
 * page opens. One build per issue and commit.
 *
 * Project main-branch previews (lib/previews/project-builds.ts) use the same
 * builder through the exported helpers below.
 */

export const WORKFLOW = "preview.yml";
export const BUILDER_BRANCH = "main";
/** Don't ask GitHub about the same build more often than this. */
export const RECHECK_MS = 10_000;
/** Issue statuses whose pull request is worth previewing. */
const PREVIEW_STATUSES = new Set(["in_progress", "done", "merge"]);

export type { PreviewBuildStatus };

export type PreviewBuildView = {
  id: string;
  status: PreviewBuildStatus;
  headSha: string;
  url: string | null;
  runUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type Builder = { repo: RepoRef; pagesProject: string };

/** The configured preview builder, or null when previews aren't set up on this server. */
export function previewBuilder(): Builder | null {
  const raw = process.env.PREVIEW_BUILDER_REPO?.trim();
  const match = raw?.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const pagesProject = process.env.PREVIEW_PAGES_PROJECT?.trim() || DEFAULT_PAGES_PROJECT;
  if (!/^[a-z0-9-]{1,58}$/.test(pagesProject)) return null;
  return { repo: { owner: match[1], repo: match[2] }, pagesProject };
}

/** Whether the issue's project builds previews here: the builder set up on this server and previews on for the project. */
export async function previewsOnForIssue(bugId: string): Promise<boolean> {
  if (!previewBuilder()) return false;
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: { projectId: true } });
  if (!bug) return false;
  const row = await prisma.projectPreviewSettings.findUnique({ where: { projectId: bug.projectId }, select: { enabled: true } });
  return Boolean(row?.enabled);
}

export async function builderClient(builder: Builder): Promise<GitHubClient> {
  const installationId = await installationIdForRepo(builder.repo.owner, builder.repo.repo);
  if (!installationId) {
    throw new GitHubError(
      404,
      `Ziki's GitHub App isn't installed on ${builder.repo.owner}/${builder.repo.repo}, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY aren't set.`,
    );
  }
  return githubClientFor({ githubInstallationId: installationId });
}

export const builderPath = (builder: Builder) =>
  `/repos/${encodeURIComponent(builder.repo.owner)}/${encodeURIComponent(builder.repo.repo)}/actions`;

export function oneLine(error: unknown): string {
  const message = error instanceof GitHubError ? error.message : "Ziki couldn't start the preview builder.";
  return message.replace(/\s+/g, " ").slice(0, 300);
}

/** What one builder run builds. */
export type PreviewDispatch = {
  buildId: string;
  repository: string;
  headSha: string;
  /** The Pages branch's number: the pull request, or 0 for a project's main branch. */
  pr: number;
  settings: ReturnType<typeof previewSettingsValues>;
};

/** Start the builder for one build. Throws when GitHub refuses; returns the run when GitHub says which it is. */
export async function dispatchPreviewBuild(
  builder: Builder,
  dispatch: PreviewDispatch,
): Promise<{ runId: string; runUrl: string | null } | null> {
  const client = await builderClient(builder);
  const { settings } = dispatch;
  const dispatched = await client.send<{ workflow_run_id?: number; html_url?: string } | undefined>(
    "POST",
    `${builderPath(builder)}/workflows/${WORKFLOW}/dispatches`,
    {
      ref: BUILDER_BRANCH,
      // GitHub answers with the run when it can; otherwise Ziki finds it by build ID.
      return_run_details: true,
      inputs: {
        build_id: dispatch.buildId,
        repository: dispatch.repository,
        ref: dispatch.headSha,
        pr: String(dispatch.pr),
        install_command: settings.installCommand ?? "",
        build_command: settings.buildCommand,
        root_dir: settings.rootDir,
        output_dir: settings.outputDir,
        node_version: settings.nodeVersion,
        build_variables: JSON.stringify(settings.buildVariables),
      },
    },
  );
  return dispatched?.workflow_run_id ? { runId: String(dispatched.workflow_run_id), runUrl: dispatched.html_url ?? null } : null;
}

export type PreviewTrigger = {
  bugId: string;
  projectId: string;
  issueStatus: string;
  repoUrl: string | null;
  pullRequestUrl: string;
  state: string;
  headSha: string | null;
};

/**
 * Start a preview build of the pull request's head commit when it is due:
 * previews on, the pull request open and in the main repository, and no build
 * yet for this issue and commit. Never throws: a failure is the build's
 * `failed` status, shown on the issue page.
 */
export async function startPreviewBuildIfDue(trigger: PreviewTrigger): Promise<"started" | "skipped" | "failed"> {
  const builder = previewBuilder();
  if (!builder) return "skipped";
  if (trigger.state !== "open" || !trigger.headSha || !/^[0-9a-f]{40}$/.test(trigger.headSha)) return "skipped";
  if (!PREVIEW_STATUSES.has(trigger.issueStatus)) return "skipped";
  const pull = parsePullRequestUrl(trigger.pullRequestUrl);
  const main = parseGitHubRepoUrl(trigger.repoUrl);
  // Main repository only, for now.
  if (!pull || !main || !sameRepo(pull, main)) return "skipped";

  const row = await prisma.projectPreviewSettings.findUnique({ where: { projectId: trigger.projectId } });
  const settings = previewSettingsValues(row);
  if (!settings.enabled) return "skipped";

  const repository = `${pull.owner}/${pull.repo}`;
  let build: { id: string };
  try {
    build = await prisma.previewBuild.create({
      data: {
        projectId: trigger.projectId,
        bugId: trigger.bugId,
        repository,
        pullNumber: pull.number,
        headSha: trigger.headSha,
      },
      select: { id: true },
    });
  } catch (error) {
    // Already built (or being built) for this commit.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "skipped";
    throw error;
  }

  try {
    const run = await dispatchPreviewBuild(builder, {
      buildId: build.id,
      repository,
      headSha: trigger.headSha,
      pr: pull.number,
      settings,
    });
    if (run) {
      await prisma.previewBuild.update({
        where: { id: build.id },
        data: { status: "building", runId: run.runId, runUrl: run.runUrl },
      });
    }
    return "started";
  } catch (error) {
    if (!(error instanceof GitHubError)) console.error("[previews] dispatch failed", error);
    await prisma.previewBuild.update({
      where: { id: build.id },
      data: { status: "failed", error: oneLine(error), completedAt: new Date() },
    });
    return "failed";
  }
}

type OpenBuild = {
  id: string;
  status: string;
  runId: string | null;
  repository: string;
  pullNumber: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Ask GitHub for one build's run: by its ID once known, otherwise by the build ID in the run's name. */
export async function findBuilderRun(
  builder: Builder,
  client: GitHubClient,
  build: { id: string; runId: string | null; createdAt: Date },
): Promise<WorkflowRun | null> {
  if (build.runId) {
    return client.getOrNull<WorkflowRun>(`${builderPath(builder)}/runs/${encodeURIComponent(build.runId)}`);
  }
  // The run's name carries the build ID (preview.yml `run-name`).
  const since = new Date(build.createdAt.getTime() - 60_000).toISOString();
  const runs = await client.get<{ workflow_runs: WorkflowRun[] }>(
    `${builderPath(builder)}/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${since}`)}`,
  );
  return runForBuild(runs.workflow_runs, build.id);
}

/** Ask GitHub where one build's run is, and record it. */
async function followBuild(builder: Builder, client: GitHubClient, build: OpenBuild): Promise<void> {
  const run = await findBuilderRun(builder, client, build);
  await prisma.previewBuild.update({
    where: { id: build.id },
    data: changesForRun(run, build.createdAt, previewUrl(build.repository, build.pullNumber, builder.pagesProject)),
  });
}

/** Follow the unfinished builds matching `where`, a few at a time. */
async function followBuilds(where: Prisma.PreviewBuildWhereInput, limit: number): Promise<{ checked: number; failed: number }> {
  const builder = previewBuilder();
  if (!builder) return { checked: 0, failed: 0 };
  const builds = await prisma.previewBuild.findMany({
    where: { ...where, status: { in: ["queued", "building"] }, updatedAt: { lt: new Date(Date.now() - RECHECK_MS) } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, status: true, runId: true, repository: true, pullNumber: true, createdAt: true, updatedAt: true },
  });
  if (!builds.length) return { checked: 0, failed: 0 };
  let client: GitHubClient;
  try {
    client = await builderClient(builder);
  } catch (error) {
    if (!(error instanceof GitHubError)) console.error("[previews] builder access failed", error);
    return { checked: 0, failed: builds.length };
  }
  let failed = 0;
  for (const build of builds) {
    try {
      await followBuild(builder, client, build);
    } catch (error) {
      failed++;
      if (!(error instanceof GitHubError)) console.error("[previews] follow failed", build.id, error);
    }
  }
  return { checked: builds.length, failed };
}

/** Follow one issue's unfinished builds (the issue page, GitHub reads). */
export function followIssuePreviewBuilds(bugId: string): Promise<{ checked: number; failed: number }> {
  return followBuilds({ bugId }, 5);
}

/** The cron sweep: follow every unfinished build, oldest check first. */
export function followPreviewBuilds(options: { limit?: number } = {}): Promise<{ checked: number; failed: number }> {
  return followBuilds({}, options.limit ?? 20);
}

/** The latest build of the issue's pull request, for the issue page. */
export async function latestPreviewBuild(bugId: string, pullRequestUrl: string | null): Promise<PreviewBuildView | null> {
  const pull = parsePullRequestUrl(pullRequestUrl);
  if (!pull) return null;
  const build = await prisma.previewBuild.findFirst({
    where: { bugId, pullNumber: pull.number, repository: { equals: `${pull.owner}/${pull.repo}`, mode: "insensitive" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, headSha: true, url: true, runUrl: true, error: true, createdAt: true, completedAt: true },
  });
  if (!build) return null;
  return {
    id: build.id,
    status: viewStatus(build.status),
    headSha: build.headSha,
    url: build.url,
    runUrl: build.runUrl,
    error: build.error,
    createdAt: build.createdAt.toISOString(),
    completedAt: build.completedAt?.toISOString() ?? null,
  };
}

/** The last ready preview of the pull request, shown while a newer commit builds. */
export async function lastReadyPreviewUrl(bugId: string, pullRequestUrl: string | null): Promise<string | null> {
  const pull = parsePullRequestUrl(pullRequestUrl);
  if (!pull) return null;
  const build = await prisma.previewBuild.findFirst({
    where: { bugId, pullNumber: pull.number, status: "ready", repository: { equals: `${pull.owner}/${pull.repo}`, mode: "insensitive" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { url: true },
  });
  return build?.url ?? null;
}