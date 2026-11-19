import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  settingsUpdate: vi.fn(),
  settingsFindMany: vi.fn(),
  buildFindUnique: vi.fn(),
  buildFindMany: vi.fn(),
  buildCreate: vi.fn(),
  buildUpdate: vi.fn(),
  buildDelete: vi.fn(),
  getOrNull: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
  installationIdForRepo: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    projectPreviewSettings: { update: mocks.settingsUpdate, findMany: mocks.settingsFindMany },
    projectPreviewBuild: {
      findUnique: mocks.buildFindUnique,
      findMany: mocks.buildFindMany,
      create: mocks.buildCreate,
      update: mocks.buildUpdate,
      delete: mocks.buildDelete,
    },
  },
}));
vi.mock("@/lib/github/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/client")>()),
  installationIdForRepo: mocks.installationIdForRepo,
  githubClientFor: vi.fn(async () => ({ auth: "app", canWrite: true, get: mocks.get, getOrNull: mocks.getOrNull, send: mocks.send })),
}));

import { followProjectPreviewBuilds, startProjectPreviewIfDue, sweepProjectPreviews } from "./project-builds";
import { projectPreviewUrl } from "./address";

const HEAD = "b".repeat(40);
const settings = {
  enabled: true,
  rootDir: ".",
  installCommand: null,
  buildCommand: "npm run build",
  outputDir: "dist",
  nodeVersion: "22",
  buildVariables: {},
  mainCheckedAt: null as Date | null,
};
const project = (over: Record<string, unknown> = {}) => ({
  repoUrl: "https://github.com/acme/web",
  githubInstallationId: "777",
  archivedAt: null,
  previewSettings: settings,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PREVIEW_BUILDER_REPO", "ziki/ziki-preview-builder");
  mocks.projectFindUnique.mockResolvedValue(project());
  mocks.settingsUpdate.mockResolvedValue({});
  mocks.installationIdForRepo.mockResolvedValue("555");
  mocks.getOrNull.mockImplementation(async (path: string) => {
    if (path === "/repos/acme/web") return { default_branch: "main" };
    if (path === "/repos/acme/web/commits/main") return { sha: HEAD };
    return null;
  });
  mocks.buildFindUnique.mockResolvedValue(null);
  mocks.buildCreate.mockResolvedValue({ id: "pb1" });
  mocks.buildUpdate.mockResolvedValue({});
  mocks.send.mockResolvedValue({ workflow_run_id: 99, html_url: "https://github.com/ziki/ziki-preview-builder/actions/runs/99" });
});

describe("startProjectPreviewIfDue (#project-previews)", () => {
  it("builds the main branch's new commit as the project's fixed preview", async () => {
    await expect(startProjectPreviewIfDue("p1")).resolves.toEqual({ outcome: "started" });
    expect(mocks.settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "p1" } }));
    expect(mocks.buildCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: { projectId: "p1", repository: "acme/web", branch: "main", headSha: HEAD },
    }));
    const [, path, body] = mocks.send.mock.calls[0];
    expect(path).toBe("/repos/ziki/ziki-preview-builder/actions/workflows/preview.yml/dispatches");
    expect(body.inputs).toMatchObject({ build_id: "pb1", repository: "acme/web", ref: HEAD, pr: "0" });
    expect(mocks.buildUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "building", runId: "99" }),
    }));
  });

  it("builds nothing when previews are off, not set up, or there's no repository", async () => {
    mocks.projectFindUnique.mockResolvedValueOnce(project({ previewSettings: { ...settings, enabled: false } }));
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "skipped" });
    mocks.projectFindUnique.mockResolvedValueOnce(project({ repoUrl: null }));
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "skipped" });
    mocks.projectFindUnique.mockResolvedValueOnce(project({ previewSettings: null }));
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "skipped" });
    vi.stubEnv("PREVIEW_BUILDER_REPO", "");
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "skipped" });
    expect(mocks.buildCreate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("waits a few minutes between checks, unless asked to build now", async () => {
    mocks.projectFindUnique.mockResolvedValue(project({ previewSettings: { ...settings, mainCheckedAt: new Date() } }));
    await expect(startProjectPreviewIfDue("p1")).resolves.toEqual({ outcome: "up_to_date" });
    expect(mocks.getOrNull).not.toHaveBeenCalled();
    await expect(startProjectPreviewIfDue("p1", { force: true })).resolves.toEqual({ outcome: "started" });
  });

  it("builds each commit once", async () => {
    mocks.buildFindUnique.mockResolvedValue({ id: "pb0", status: "ready" });
    await expect(startProjectPreviewIfDue("p1", { force: true })).resolves.toEqual({ outcome: "up_to_date" });
    expect(mocks.buildCreate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retries a commit that failed only when asked to build now", async () => {
    mocks.buildFindUnique.mockResolvedValue({ id: "pb0", status: "failed" });
    await expect(startProjectPreviewIfDue("p1")).resolves.toEqual({ outcome: "up_to_date" });
    expect(mocks.buildDelete).not.toHaveBeenCalled();
    await expect(startProjectPreviewIfDue("p1", { force: true })).resolves.toEqual({ outcome: "started" });
    expect(mocks.buildDelete).toHaveBeenCalledWith({ where: { id: "pb0" } });
  });

  it("says so when the main branch can't be read", async () => {
    mocks.getOrNull.mockResolvedValue(null);
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "failed" });
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it("records the build as failed when the builder can't be started", async () => {
    mocks.installationIdForRepo.mockResolvedValue(null);
    await expect(startProjectPreviewIfDue("p1")).resolves.toMatchObject({ outcome: "failed" });
    expect(mocks.buildUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed" }),
    }));
  });
});

describe("followProjectPreviewBuilds (#project-previews)", () => {
  it("marks a finished run ready at the project's fixed address", async () => {
    mocks.buildFindMany.mockResolvedValue([{ id: "pb1", runId: "99", repository: "acme/web", createdAt: new Date() }]);
    mocks.getOrNull.mockResolvedValue({ id: 99, status: "completed", conclusion: "success", html_url: "https://github.com/x/runs/99" });
    await expect(followProjectPreviewBuilds()).resolves.toEqual({ checked: 1, failed: 0 });
    expect(mocks.buildUpdate).toHaveBeenCalledWith({
      where: { id: "pb1" },
      data: expect.objectContaining({ status: "ready", url: projectPreviewUrl("acme/web") }),
    });
  });
});

describe("sweepProjectPreviews (#project-previews)", () => {
  it("checks the projects that are due", async () => {
    mocks.settingsFindMany.mockResolvedValue([{ projectId: "p1" }]);
    await expect(sweepProjectPreviews()).resolves.toEqual({ checked: 1, started: 1 });
  });
});
