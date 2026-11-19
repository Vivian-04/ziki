/**
 * What a preview build's builder run means for its record (#previews). Shared
 * by pull request previews (lib/previews/builds.ts) and project main-branch
 * previews (lib/previews/project-builds.ts), so both read runs the same way.
 * No database or GitHub calls here, so it's easy to test.
 */

/** A dispatched build whose run never shows up is given up after this. */
export const QUEUED_TIMEOUT_MS = 15 * 60_000;
/** A run still going after this is given up. */
export const BUILDING_TIMEOUT_MS = 45 * 60_000;

export type PreviewBuildStatus = "queued" | "building" | "ready" | "failed";

export type WorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  display_title?: string;
};

/** The fields to update on a build record after asking GitHub about its run. */
export type BuildChanges = {
  status?: PreviewBuildStatus;
  runId?: string;
  runUrl?: string;
  url?: string;
  error?: string | null;
  completedAt?: Date;
  updatedAt?: Date;
};

/** The run for build `buildId` among recent builder runs: the run's name carries the build ID (preview.yml `run-name`). */
export function runForBuild(runs: WorkflowRun[], buildId: string): WorkflowRun | null {
  return runs.find((candidate) => candidate.display_title?.includes(`(${buildId})`)) ?? null;
}

/**
 * What to record for a build started at `createdAt`, given its run (or no run
 * seen yet). `readyUrl` is the preview's address once the run succeeds.
 */
export function changesForRun(run: WorkflowRun | null, createdAt: Date, readyUrl: string, now: Date = new Date()): BuildChanges {
  const waited = now.getTime() - createdAt.getTime();
  if (!run) {
    return waited > QUEUED_TIMEOUT_MS
      ? { status: "failed", error: "The preview builder never started a run for this commit.", completedAt: now }
      : { updatedAt: now };
  }

  const base = { runId: String(run.id), runUrl: run.html_url };
  if (run.status !== "completed") {
    return waited > BUILDING_TIMEOUT_MS
      ? { ...base, status: "failed", error: "The preview build took too long.", completedAt: now }
      : { ...base, status: "building" };
  }
  if (run.conclusion === "success") {
    return { ...base, status: "ready", url: readyUrl, error: null, completedAt: now };
  }
  return {
    ...base,
    status: "failed",
    error:
      run.conclusion === "cancelled"
        ? "The preview build was cancelled."
        : "The preview build failed. Check that the install and build commands and the output folder in the project's preview settings match the repository.",
    completedAt: now,
  };
}

/** A stored status as one the page knows; anything unexpected reads as failed. */
export function viewStatus(status: string): PreviewBuildStatus {
  return status === "queued" || status === "building" || status === "ready" || status === "failed" ? status : "failed";
}
