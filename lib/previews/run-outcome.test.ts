import { describe, expect, it } from "vitest";
import { BUILDING_TIMEOUT_MS, QUEUED_TIMEOUT_MS, changesForRun, runForBuild, viewStatus, type WorkflowRun } from "./run-outcome";

const createdAt = new Date("2026-11-19T10:00:00Z");
const after = (ms: number) => new Date(createdAt.getTime() + ms);
const URL = "https://pr-0-abc.ziki-previews.pages.dev";
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 42,
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/o/r/actions/runs/42",
  ...over,
});

describe("runForBuild", () => {
  it("finds the run whose name carries the build ID", () => {
    const runs = [run({ id: 1, display_title: "Preview (other)" }), run({ id: 2, display_title: "Preview (b1)" })];
    expect(runForBuild(runs, "b1")?.id).toBe(2);
  });

  it("is null when no run matches", () => {
    expect(runForBuild([run({ display_title: "Preview (other)" })], "b1")).toBeNull();
  });
});

describe("changesForRun", () => {
  it("only notes the check while waiting for a run to appear", () => {
    const now = after(60_000);
    expect(changesForRun(null, createdAt, URL, now)).toEqual({ updatedAt: now });
  });

  it("gives up when no run appears in time", () => {
    const changes = changesForRun(null, createdAt, URL, after(QUEUED_TIMEOUT_MS + 1));
    expect(changes.status).toBe("failed");
    expect(changes.error).toMatch(/never started a run/);
  });

  it("records a running build", () => {
    expect(changesForRun(run({}), createdAt, URL, after(60_000))).toEqual({
      runId: "42",
      runUrl: "https://github.com/o/r/actions/runs/42",
      status: "building",
    });
  });

  it("gives up on a run that takes too long", () => {
    const changes = changesForRun(run({}), createdAt, URL, after(BUILDING_TIMEOUT_MS + 1));
    expect(changes.status).toBe("failed");
    expect(changes.error).toMatch(/took too long/);
  });

  it("marks a successful run ready at the preview address", () => {
    const changes = changesForRun(run({ status: "completed", conclusion: "success" }), createdAt, URL, after(60_000));
    expect(changes).toMatchObject({ status: "ready", url: URL, error: null });
  });

  it("explains a cancelled run", () => {
    const changes = changesForRun(run({ status: "completed", conclusion: "cancelled" }), createdAt, URL, after(60_000));
    expect(changes).toMatchObject({ status: "failed", error: "The preview build was cancelled." });
  });

  it("points at the settings when a run fails", () => {
    const changes = changesForRun(run({ status: "completed", conclusion: "failure" }), createdAt, URL, after(60_000));
    expect(changes.status).toBe("failed");
    expect(changes.error).toMatch(/preview settings/);
  });
});

describe("viewStatus", () => {
  it("keeps known statuses and reads anything else as failed", () => {
    expect(viewStatus("ready")).toBe("ready");
    expect(viewStatus("building")).toBe("building");
    expect(viewStatus("weird")).toBe("failed");
  });
});
