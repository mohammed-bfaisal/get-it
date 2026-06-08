"use client";

/**
 * Top-bar Account button + popover.
 *
 * Shows the currently authenticated ChatGPT/Codex identity, the 5h and
 * weekly usage windows (fetched fresh every time the popover opens),
 * and a Sign-out button that runs `codex logout` and re-launches the
 * Electron setup wizard. Designed to live on every page's top bar.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CircleUserRound,
  LogOut,
  RefreshCw,
  User as UserIcon,
} from "lucide-react";

type AccountSnapshot = {
  provider?: "codex" | "openrouter";
  openRouter?: {
    model: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
  };
  account: {
    email: string | null;
    name: string | null;
    planType: string | null;
    organizations: Array<{ id: string; title: string; role: string }>;
    subscriptionActiveUntil: string | null;
    authMode: string | null;
  } | null;
  rateLimits: {
    planType: string | null;
    primary: {
      usedPercent: number;
      windowDurationMins: number;
      resetsAt: number | null;
    } | null;
    secondary: {
      usedPercent: number;
      windowDurationMins: number;
      resetsAt: number | null;
    } | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
    rateLimitReachedType: string | null;
  } | null;
};

// `window.getit` is declared globally in components/CodexHealthBanner.tsx;
// this component only consumes it.

export default function AccountButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <span className="viz-tooltip-anchor relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="tab-icon-btn"
          aria-label="Account"
        >
          <CircleUserRound className="h-3.5 w-3.5" />
        </button>
        {!open && (
          <span className="viz-tooltip" role="tooltip">
            AI provider, usage limits and sign-out.
          </span>
        )}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            key="account-menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-30 mt-1.5 w-[22rem] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-white shadow-[0_8px_24px_rgba(17,17,19,0.08)]"
          >
            <AccountPanel refreshKey={open ? "open" : "closed"} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AccountPanel({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<AccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (refreshKey !== "open") return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch("/api/codex/account", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as AccountSnapshot;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr((e as Error).message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    if (data?.provider === "openrouter") return;
    if (
      !confirm(
        "Sign out of Codex? Your library and study data stay on this device.",
      )
    ) {
      return;
    }
    setLoggingOut(true);
    try {
      await fetch("/api/codex/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined" && window.getit?.runCodexSetup) {
      try {
        await window.getit.runCodexSetup();
      } catch {
        /* ignore */
      }
    }
    setLoggingOut(false);
  }, [data?.provider, loggingOut]);

  const isOpenRouter = data?.provider === "openrouter";

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
          {isOpenRouter ? "OpenRouter provider" : "ChatGPT account"}
        </p>
        {!isOpenRouter && (
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut || (!data?.account && !err)}
          title="Sign out of Codex and return to the setup wizard"
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-white px-2 py-0.5 text-[10.5px] font-medium text-[var(--ink-700)] transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
        >
          {loggingOut ? (
            <RefreshCw className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <LogOut className="h-2.5 w-2.5" />
          )}
          {loggingOut ? "signing out…" : "Sign out"}
        </button>
        )}
      </div>

      {loading && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--ink-400)]">
          <RefreshCw className="h-3 w-3 animate-spin text-[var(--accent-600)]" />
          fetching provider status...
        </div>
      )}

      {!loading && isOpenRouter && data?.openRouter && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-500)]">
              <UserIcon className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium text-[var(--ink-900)]">
                OpenRouter API key
              </p>
              <p className="truncate text-[10.5px] text-[var(--ink-500)]">
                {data.openRouter.apiKeyConfigured ? "configured" : "missing"}
              </p>
            </div>
          </div>
          <div className="space-y-1 rounded-md bg-[var(--surface-sunken)] px-2 py-1.5 text-[10.5px] text-[var(--ink-600)]">
            <p className="truncate">
              <span className="font-medium text-[var(--ink-800)]">Model:</span>{" "}
              {data.openRouter.model}
            </p>
            <p className="truncate">
              <span className="font-medium text-[var(--ink-800)]">Endpoint:</span>{" "}
              {data.openRouter.baseUrl}
            </p>
          </div>
        </div>
      )}

      {!loading && !isOpenRouter && (err || !data?.account) && (
        <p className="mt-1.5 text-[11px] text-[var(--ink-400)]">No data.</p>
      )}

      {!loading && !isOpenRouter && data?.account && (
        <>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-500)]">
              <UserIcon className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium text-[var(--ink-900)]">
                {data.account.name ?? data.account.email ?? "Signed in"}
              </p>
              <p className="truncate text-[10.5px] text-[var(--ink-500)]">
                {data.account.email ?? ""}
                {data.account.planType ? (
                  <>
                    {data.account.email ? " · " : ""}
                    <span className="font-medium uppercase text-[var(--accent-700)]">
                      {data.account.planType}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          {data.rateLimits ? (
            <div className="mt-2 space-y-1.5">
              <LimitRow label="5h limit" win={data.rateLimits.primary} />
              <LimitRow label="Weekly limit" win={data.rateLimits.secondary} />
            </div>
          ) : (
            <p className="mt-2 text-[10.5px] text-[var(--ink-400)]">
              Usage limits unavailable.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function LimitRow({
  label,
  win,
}: {
  label: string;
  win: {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number | null;
  } | null;
}) {
  if (!win) {
    return (
      <div className="flex items-center justify-between text-[10.5px] text-[var(--ink-400)]">
        <span>{label}</span>
        <span>no data</span>
      </div>
    );
  }
  const used = Math.max(0, Math.min(100, Math.round(win.usedPercent)));
  const tone =
    used >= 90
      ? "bg-rose-500"
      : used >= 60
        ? "bg-amber-500"
        : "bg-[var(--accent-600)]";
  const resetIn = win.resetsAt ? formatResetIn(win.resetsAt * 1000) : null;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-[var(--ink-700)]">{label}</span>
        <span className="tabular-nums text-[var(--ink-900)]">
          {used}% used
          {resetIn ? (
            <span className="ml-1 font-normal text-[var(--ink-400)]">
              · resets in {resetIn}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div className={`h-full ${tone}`} style={{ width: `${used}%` }} />
      </div>
    </div>
  );
}

function formatResetIn(absMs: number): string {
  const dt = absMs - Date.now();
  if (dt <= 0) return "now";
  const totalMin = Math.round(dt / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
