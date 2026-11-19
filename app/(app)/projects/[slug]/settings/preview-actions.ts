"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth-helpers";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { currentOrganisationIdFor, NO_ORGANISATION_MESSAGE } from "@/lib/organisation-context";
import { prisma } from "@/lib/prisma";
import {
  previewSettingsSchema,
  previewSettingsValues,
  type PreviewSettingsValues,
} from "@/lib/validations/preview-settings";
import {
  followProjectPreviewBuilds,
  latestProjectPreview,
  startProjectPreviewIfDue,
} from "@/lib/previews/project-builds";
import type { PreviewBuildView } from "@/lib/previews/builds";

export type PreviewSettingsActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const FIELDS = [
  "enabled",
  "rootDir",
  "installCommand",
  "buildCommand",
  "outputDir",
  "nodeVersion",
  "buildVariables",
] as const satisfies ReadonlyArray<keyof PreviewSettingsValues>;

/** Save how Ziki builds previews of the project's main repository (#previews). Organisation owners/admins only. */
export async function updateProjectPreviewSettingsAction(
  _previous: PreviewSettingsActionResult | undefined,
  formData: FormData,
): Promise<PreviewSettingsActionResult> {
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) return { ok: false, error: NO_ORGANISATION_MESSAGE };
  if (!(await isAdminOfOrganisation(user, organisationId))) {
    return { ok: false, error: "Only organisation owners and admins can change preview settings." };
  }
  const slug = String(formData.get("slug") ?? "").trim();
  const project = await prisma.project.findFirst({
    where: { organisationId, slug },
    select: { id: true, slug: true, repoUrl: true, previewSettings: true },
  });
  if (!project) return { ok: false, error: "Project not found." };

  const parsed = previewSettingsSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    rootDir: String(formData.get("rootDir") ?? ""),
    installCommand: String(formData.get("installCommand") ?? ""),
    buildCommand: String(formData.get("buildCommand") ?? ""),
    outputDir: String(formData.get("outputDir") ?? ""),
    nodeVersion: String(formData.get("nodeVersion") ?? ""),
    buildVariables: String(formData.get("buildVariables") ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the preview settings.", fieldErrors };
  }
  if (parsed.data.enabled && !project.repoUrl?.trim()) {
    return {
      ok: false,
      error: "Add the project's repository in Details & rewards before turning previews on.",
      fieldErrors: { enabled: "The project has no main repository yet." },
    };
  }

  const current = previewSettingsValues(project.previewSettings);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of FIELDS) {
    if (JSON.stringify(current[field]) !== JSON.stringify(parsed.data[field])) {
      changes[field] = { from: current[field], to: parsed.data[field] };
    }
  }

  if (Object.keys(changes).length > 0) {
    const data = { ...parsed.data, buildVariables: parsed.data.buildVariables as Prisma.InputJsonObject };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.projectPreviewSettings.upsert({
          where: { projectId: project.id },
          update: data,
          create: { projectId: project.id, ...data },
        });
        await tx.projectAuditEvent.create({
          data: {
            organisationId,
            projectId: project.id,
            actorUserId: user.id,
            action: "previews.updated",
            changes: changes as Prisma.InputJsonValue,
          },
        });
      });
    } catch {
      // The transaction rolled back: the old settings still apply.
      return { ok: false, error: "Couldn't save the preview settings. Try again." };
    }
  }

  revalidatePath(`/projects/${encodeURIComponent(project.slug)}/settings`);
  return { ok: true };
}

export type ProjectPreviewStatusResult =
  | { ok: true; build: PreviewBuildView | null; lastReadyUrl: string | null; message?: string }
  | { ok: false; error: string };

/** The project in the admin's current organisation, or an error to show. */
async function projectForPreviewAdmin(slug: unknown): Promise<{ id: string } | { error: string }> {
  if (typeof slug !== "string" || !slug.trim()) return { error: "Project not found." };
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) return { error: NO_ORGANISATION_MESSAGE };
  if (!(await isAdminOfOrganisation(user, organisationId))) {
    return { error: "Only organisation owners and admins can see the project preview." };
  }
  const project = await prisma.project.findFirst({ where: { organisationId, slug: slug.trim() }, select: { id: true } });
  return project ?? { error: "Project not found." };
}

/** The main-branch preview card (#project-previews): ask the builder again, then answer with the latest build. */
export async function projectPreviewStatusAction(slug: string): Promise<ProjectPreviewStatusResult> {
  const project = await projectForPreviewAdmin(slug);
  if ("error" in project) return { ok: false, error: project.error };
  await followProjectPreviewBuilds({ projectId: project.id, limit: 3 }).catch((error) =>
    console.error("[project-previews] follow failed", error),
  );
  return { ok: true, ...(await latestProjectPreview(project.id)) };
}

/** Build now (#project-previews): build the main branch's latest commit straight away. */
export async function buildProjectPreviewNowAction(slug: string): Promise<ProjectPreviewStatusResult> {
  const project = await projectForPreviewAdmin(slug);
  if ("error" in project) return { ok: false, error: project.error };
  const result = await startProjectPreviewIfDue(project.id, { force: true });
  const latest = await latestProjectPreview(project.id);
  const message =
    result.outcome === "started"
      ? "Building the main branch's latest commit."
      : result.outcome === "up_to_date"
        ? "The preview already shows the main branch's latest commit."
        : result.reason;
  if (result.outcome === "failed" || result.outcome === "skipped") {
    return { ok: false, error: message };
  }
  return { ok: true, ...latest, message };
}
