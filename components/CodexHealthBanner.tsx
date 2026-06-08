"use client";

/**
 * Codex health banner.
 *
 * Renders nothing while Codex is healthy. When the most recent Codex call
 * failed with a classified error, slides down a banner that explains the
 * problem in plain language and exposes the right next step:
 *
 *   • auth_lost / binary_missing → "Re-connect" button that invokes the
 *     Electron setup wizard (via the preload bridge). In a plain browser
 *     dev session the button degrades to a help link.
 *
 *   • rate_limit → live countdown to the retryAt timestamp (when known),
 *     or a static "try again later" line. Auto-hides once the deadline
 *     passes and the next Codex call succeeds.
 *
 *   • generic → simple "Something went wrong" with a Retry hint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, KeyRound, Clock, Loader2, X } from "lucide-react";

type Health = {
  ok: boolean;
  provider?: "codex" | "openrouter";
  kind: "auth_lost" | "rate_limit" | "binary_missing" | "generic" | null;
  message: string | null;
  retryAt: number | null;
  window: "5h" | "weekly" | "unknown" | null;
  serial: number;
  lastOkAt: number | null;
};

declare global {
  interface Window {
    getit?: {
      runCodexSetup?: () => Promise<unknown>;
      onCodexStatus?: (cb: (s: unknown) => void) => () => void;
    };
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export default function CodexHealthBanner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dismissedSerial, setDismissedSerial] = useState<number>(-1);
  const [reconnecting, setReconnecting] = useState(false);
  const [, force] = useState(0);

  // Poll cadence: fast when there's an active problem so the user sees
  // recovery quickly; slow when healthy so we don't waste battery.
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/codex/health", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as Health;
        if (cancelled) return;
        setHealth(j);
      } catch {
        /* ignore */
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, health && !health.ok ? 2000 : 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [health?.ok]);

  // Tick once a second for the rate-limit countdown.
  useEffect(() => {
    if (!health || health.ok || health.kind !== "rate_limit" || !health.retryAt) return;
    const id = setInterval(() => force((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [health?.ok, health?.kind, health?.retryAt]);

  const handleReconnect = useCallback(async () => {
    if (!window.getit?.runCodexSetup) {
      // dev/browser fallback — open a help link
      window.open("https://github.com/openai/codex#login", "_blank");
      return;
    }
    setReconnecting(true);
    try {
      await window.getit.runCodexSetup();
    } finally {
      setReconnecting(false);
    }
  }, []);

  const view = useMemo(() => {
    if (!health || health.ok) return null;
    if (dismissedSerial === health.serial) return null;
    return health;
  }, [health, dismissedSerial]);

  if (!view) return null;

  let icon = <AlertTriangle className="h-4 w-4 text-amber-600" />;
  let title = "Codex hit a snag";
  let body: React.ReactNode = view.message ?? "";
  let action: React.ReactNode = null;
  const isOpenRouter = view.provider === "openrouter";

  if (view.kind === "auth_lost" || view.kind === "binary_missing") {
    icon = <KeyRound className="h-4 w-4 text-rose-600" />;
    title = isOpenRouter
      ? "OpenRouter API key needed"
      : view.kind === "auth_lost"
        ? "Codex needs a sign-in"
        : "Codex CLI is missing";
    body =
      view.kind === "auth_lost"
        ? "Your Codex session expired or signed out. Re-connect to keep working — your data is safe."
        : "We can't find the Codex CLI binary. Open the setup wizard to install it.";
    if (isOpenRouter) {
      body =
        "Set OPENROUTER_API_KEY in .env.local or your shell environment, then restart Get It.";
    }
    action = (
      <button
        type="button"
        onClick={handleReconnect}
        disabled={reconnecting}
        className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1 text-[12px] font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-60"
      >
        {reconnecting ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <KeyRound className="h-3 w-3" />
        )}
        Re-connect
      </button>
    );
    if (isOpenRouter) action = null;
  } else if (view.kind === "rate_limit") {
    icon = <Clock className="h-4 w-4 text-amber-600" />;
    const win =
      view.window === "weekly"
        ? "weekly"
        : view.window === "5h"
          ? "5-hour"
          : "current";
    if (view.retryAt) {
      const remaining = view.retryAt - Date.now();
      title = `${isOpenRouter ? "OpenRouter" : "Codex"} ${win} limit reached`;
      body = (
        <>
          You&apos;ve used your {win} quota. We&apos;ll resume in{" "}
          <strong>{formatDuration(remaining)}</strong>. Your work is saved —
          come back and pick up where you left off.
        </>
      );
    } else {
      title = `${isOpenRouter ? "OpenRouter" : "Codex"} ${win} limit reached`;
      body =
        "You've hit your usage quota. Try again later — your work is saved.";
    }
  } else {
    icon = <AlertTriangle className="h-4 w-4 text-amber-600" />;
    title = isOpenRouter ? "Last OpenRouter call failed" : "Last Codex call failed";
    body = view.message ?? "Unknown error. Try again.";
  }

  const palette =
    view.kind === "auth_lost" || view.kind === "binary_missing"
      ? "border-rose-200 bg-rose-50 text-rose-900"
      : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div
      className={`fixed left-1/2 top-2 z-50 flex w-[min(720px,calc(100vw-32px))] -translate-x-1/2 items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-[0_8px_24px_rgba(17,17,19,0.08)] ${palette}`}
      role="alert"
    >
      <div className="mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed">{body}</p>
      </div>
      {action}
      <button
        type="button"
        onClick={() => setDismissedSerial(view.serial)}
        title="Dismiss"
        className="ml-1 shrink-0 rounded-md p-1 text-current/60 transition hover:bg-black/5"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
