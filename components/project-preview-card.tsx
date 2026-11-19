"use client";

import { useEffect, useState, useTransition } from "react";
import {
  buildProjectPreviewNowAction,
  projectPreviewStatusAction,
} from "@/app/(app)/projects/[slug]/settings/preview-actions";
import type { PreviewBuildView } from "@/lib/previews/builds";
import { Button } from "@/components/ui/button";

export type ProjectPreviewCardProps = {
  slug: string;
  /** Ziki's latest build of the main branch, or null before the first one. */
  build: PreviewBuildView | null;
  /** The last ready preview, still linked while a newer commit builds or after it failed. */
  lastReadyUrl: string | null;
  /** Previews on for the project (saved). */
  enabled: boolean;
};

/** Ask again this often while the build runs. */
const POLL_MS = 15_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function elapsed(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The project's main-branch preview (#project-previews): one compact row with the fixed link and Build now. */
export function ProjectPreviewCard({ slug, build: initialBuild, lastReadyUrl: initialLastReady, enabled }: ProjectPreviewCardProps) {
  const [build, setBuild] = useState(initialBuild);
  const [lastReadyUrl, setLastReadyUrl] = useState(initialLastReady);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const running = build?.status === "queued" || build?.status === "building";

  // A fresh server render (router refresh) replaces what polling found.
  const [shownProps, setShownProps] = useState({ initialBuild, initialLastReady });
  if (shownProps.initialBuild !== initialBuild || shownProps.initialLastReady !== initialLastReady) {
    setShownProps({ initialBuild, initialLastReady });
    setBuild(initialBuild);
    setLastReadyUrl(initialLastReady);
  }

  // Keep asking while it builds, and tick the elapsed time.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const poll = setInterval(async () => {
      const result = await projectPreviewStatusAction(slug).catch(() => null);
      if (cancelled || !result?.ok) return;
      setBuild(result.build);
      setLastReadyUrl(result.lastReadyUrl);
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [slug, running]);

  function buildNow() {
    setNotice(null);
    startTransition(async () => {
      const result = await buildProjectPreviewNowAction(slug).catch(() => null);
      if (!result) return setNotice({ tone: "bad", text: "Couldn't reach Ziki. Try again." });
      if (!result.ok) return setNotice({ tone: "bad", text: result.error });
      setBuild(result.build);
      setLastReadyUrl(result.lastReadyUrl);
      if (result.message) setNotice({ tone: "ok", text: result.message });
    });
  }

  const url = build?.status === "ready" && build.url ? build.url : lastReadyUrl;
  const commit = build?.headSha.slice(0, 7) ?? null;

  let status: { text: string; tone: string };
  if (!enabled) status = { text: "Off", tone: "bg-zk-chip text-zk-text2" };
  else if (!build) status = { text: "No preview yet", tone: "bg-zk-chip text-zk-text2" };
  else if (build.status === "ready") status = { text: "Ready", tone: "bg-zk-ok-bg text-zk-ok-fg" };
  else if (build.status === "failed") status = { text: "Build failed", tone: "bg-zk-bad-bg text-zk-bad-fg" };
  else status = { text: `Building · ${elapsed(build.createdAt, now)}`, tone: "bg-zk-warn-bg text-zk-warn-fg" };

  let detail: React.ReactNode;
  if (url) {
    detail = (
      <a href={url} target="_blank" rel="noreferrer" className="truncate font-mono text-xs font-semibold text-zk-accent hover:underline">
        {hostOf(url)} ↗
      </a>
    );
  } else if (!enabled) {
    detail = <span className="text-xs text-zk-muted">Turn previews on below to keep a live link to the main branch.</span>;
  } else if (!build) {
    detail = <span className="text-xs text-zk-muted">Ziki builds the main branch within a few minutes, and after each merge.</span>;
  } else {
    detail = <span className="text-xs text-zk-muted">The link appears here once the first build is ready.</span>;
  }

  return (
    <section
      aria-label="Main branch preview"
      data-testid="project-preview"
      data-status={build?.status ?? "none"}
      className="flex flex-col gap-1.5 rounded-xl border border-zk-border bg-zk-surface px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-zk-text">Main branch preview</span>
        <span role="status" className={`rounded-full px-2 py-0.5 text-xs font-bold ${status.tone}`}>{status.text}</span>
        {commit ? <span className="font-mono text-xs text-zk-muted">@ {commit}</span> : null}
        <span className="flex-1" />
        <Button type="button" variant="secondary" className="!px-3 !py-1 text-xs" disabled={!enabled || pending || running} onClick={buildNow}>
          {pending ? "Starting…" : "Build now"}
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {detail}
        {build?.runUrl ? (
          <a href={build.runUrl} target="_blank" rel="noreferrer" className="text-xs text-zk-muted hover:underline">
            Build log
          </a>
        ) : null}
      </div>
      {build?.status === "failed" && build.error ? <p className="m-0 text-xs text-zk-bad-fg">{build.error}</p> : null}
      {notice ? (
        <p role={notice.tone === "bad" ? "alert" : "status"} className={`m-0 text-xs ${notice.tone === "bad" ? "text-zk-bad-fg" : "text-zk-ok-fg"}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
