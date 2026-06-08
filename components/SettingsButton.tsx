"use client";

/**
 * Top-bar Settings button + popover.
 *
 * Two runtime knobs (auto-generate, viz repair budget), persisted to
 * `/api/settings`. Stateless from the parent's POV — every popover open
 * does a fresh fetch, every change POSTs back, and a `getit:settings`
 * CustomEvent is dispatched so other components on the page (the viewer
 * orchestrator in particular) can react mid-session without polling.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, KeyRound, Settings2, Trash2 } from "lucide-react";
import { AUTO_GENERATE_VIZ, MAX_VIZ_GEN_RETRIES } from "@/lib/config";
import { APP_VERSION } from "@/lib/version";

type AiProviderPreference = "auto" | "codex" | "openrouter";
type AiProvider = "codex" | "openrouter";
type OpenRouterKeySource = "local" | "environment" | null;

export type SettingsPayload = {
  autoGenerate: boolean;
  maxRetries: number;
  aiProvider: AiProviderPreference;
  resolvedProvider: AiProvider;
  openRouter: {
    model: string;
    baseUrl: string;
    maxTokens: number | null;
    apiKeyConfigured: boolean;
    apiKeySource: OpenRouterKeySource;
  };
};

type SettingsUpdate = Partial<
  Omit<SettingsPayload, "openRouter" | "resolvedProvider"> & {
    openRouter: Partial<{
      apiKey: string;
      clearApiKey: boolean;
      model: string;
      baseUrl: string;
      maxTokens: number | null;
    }>;
  }
>;

export const SETTINGS_EVENT = "getit:settings";

export default function SettingsButton() {
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
          aria-label="Settings"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        {!open && (
          <span className="viz-tooltip" role="tooltip">
            Settings — visualization preferences for this app.
          </span>
        )}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            key="settings-menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-30 mt-1.5 w-[22rem] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-white shadow-[0_8px_24px_rgba(17,17,19,0.08)]"
          >
            <SettingsPanel refreshKey={open ? "open" : "closed"} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SettingsPanel({ refreshKey }: { refreshKey: string }) {
  const [autoGenerate, setAutoGenerate] = useState<boolean>(AUTO_GENERATE_VIZ);
  const [maxRetries, setMaxRetries] = useState<number>(MAX_VIZ_GEN_RETRIES);
  const [aiProvider, setAiProvider] = useState<AiProviderPreference>("auto");
  const [resolvedProvider, setResolvedProvider] = useState<AiProvider>("codex");
  const [openRouterModel, setOpenRouterModel] = useState("openai/gpt-4o-mini");
  const [openRouterBaseUrl, setOpenRouterBaseUrl] = useState(
    "https://openrouter.ai/api/v1",
  );
  const [openRouterMaxTokens, setOpenRouterMaxTokens] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<OpenRouterKeySource>(null);
  const [savingOpenRouter, setSavingOpenRouter] = useState(false);
  const hydratedRef = useRef(false);

  const applySettings = useCallback((s: SettingsPayload) => {
    if (typeof s.autoGenerate === "boolean") setAutoGenerate(s.autoGenerate);
    if (typeof s.maxRetries === "number") setMaxRetries(s.maxRetries);
    if (s.aiProvider === "auto" || s.aiProvider === "codex" || s.aiProvider === "openrouter") {
      setAiProvider(s.aiProvider);
    }
    if (s.resolvedProvider === "codex" || s.resolvedProvider === "openrouter") {
      setResolvedProvider(s.resolvedProvider);
    }
    if (s.openRouter) {
      if (typeof s.openRouter.model === "string") setOpenRouterModel(s.openRouter.model);
      if (typeof s.openRouter.baseUrl === "string") {
        setOpenRouterBaseUrl(s.openRouter.baseUrl);
      }
      setOpenRouterMaxTokens(
        typeof s.openRouter.maxTokens === "number"
          ? String(s.openRouter.maxTokens)
          : "",
      );
      setApiKeyConfigured(!!s.openRouter.apiKeyConfigured);
      setApiKeySource(s.openRouter.apiKeySource ?? null);
    }
  }, []);

  // Fetch fresh on every popover open so external changes (CLI edits,
  // a previous run-through-the-wizard, etc.) show up.
  useEffect(() => {
    if (refreshKey !== "open") return;
    hydratedRef.current = false;
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: SettingsPayload) => {
        if (cancelled) return;
        applySettings(s);
        setOpenRouterKey("");
        hydratedRef.current = true;
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [applySettings, refreshKey]);

  const persist = useCallback((delta: SettingsUpdate) => {
    if (!hydratedRef.current) return;
    return fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delta),
      keepalive: true,
    })
      .then((r) => r.json())
      .then((next: SettingsPayload) => {
        applySettings(next);
        // Broadcast so siblings on this page (the viewer) can react.
        try {
          window.dispatchEvent(
            new CustomEvent(SETTINGS_EVENT, { detail: next }),
          );
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, [applySettings]);

  const onAutoGenerate = useCallback(
    (v: boolean) => {
      setAutoGenerate(v);
      persist({ autoGenerate: v });
    },
    [persist],
  );

  const onMaxRetries = useCallback(
    (v: number) => {
      const clamped = Math.min(10, Math.max(0, Math.floor(v)));
      setMaxRetries(clamped);
      persist({ maxRetries: clamped });
    },
    [persist],
  );

  const onProvider = useCallback(
    (v: AiProviderPreference) => {
      setAiProvider(v);
      persist({ aiProvider: v });
    },
    [persist],
  );

  const saveOpenRouter = useCallback(async () => {
    setSavingOpenRouter(true);
    const n = Number(openRouterMaxTokens);
    const maxTokens =
      openRouterMaxTokens.trim() && Number.isFinite(n) && n > 0
        ? Math.floor(n)
        : null;
    await persist({
      aiProvider,
      openRouter: {
        ...(openRouterKey.trim() ? { apiKey: openRouterKey } : {}),
        model: openRouterModel,
        baseUrl: openRouterBaseUrl,
        maxTokens,
      },
    });
    setOpenRouterKey("");
    setSavingOpenRouter(false);
  }, [
    aiProvider,
    openRouterBaseUrl,
    openRouterKey,
    openRouterMaxTokens,
    openRouterModel,
    persist,
  ]);

  const clearOpenRouterKey = useCallback(async () => {
    setSavingOpenRouter(true);
    await persist({ openRouter: { clearApiKey: true } });
    setOpenRouterKey("");
    setSavingOpenRouter(false);
  }, [persist]);

  return (
    <>
      <div className="border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
            Settings
          </p>
          <p
            className="text-[10.5px] font-medium tabular-nums text-[var(--ink-400)]"
            aria-label={`Get It. version ${APP_VERSION}`}
          >
            v{APP_VERSION}
          </p>
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-400)]">
          Saved automatically. Your choice survives app restarts.
        </p>
      </div>

      {/* AI provider */}
      <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-[var(--ink-900)]">
              AI provider
            </p>
            <p className="text-[11px] leading-relaxed text-[var(--ink-500)]">
              Active: {resolvedProvider === "openrouter" ? "OpenRouter" : "Codex"}
            </p>
          </div>
          <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-white text-[10.5px] font-medium">
            {(["auto", "codex", "openrouter"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onProvider(value)}
                className={`px-2 py-1 transition ${
                  aiProvider === value
                    ? "bg-[var(--accent-600)] text-white"
                    : "text-[var(--ink-600)] hover:bg-[var(--surface-sunken)]"
                }`}
              >
                {value === "auto"
                  ? "Auto"
                  : value === "codex"
                    ? "Codex"
                    : "OpenRouter"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 space-y-2 rounded-md bg-[var(--surface-sunken)] px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-[var(--ink-800)]">
                OpenRouter key
              </p>
              <p className="truncate text-[10.5px] text-[var(--ink-500)]">
                {apiKeyConfigured
                  ? apiKeySource === "environment"
                    ? "configured from environment"
                    : "saved locally"
                  : "missing"}
              </p>
            </div>
            {apiKeyConfigured && apiKeySource === "local" && (
              <button
                type="button"
                onClick={clearOpenRouterKey}
                disabled={savingOpenRouter}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-white text-[var(--ink-500)] transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                aria-label="Clear saved OpenRouter key"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex gap-1.5">
            <div className="relative min-w-0 flex-1">
              <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-400)]" />
              <input
                type="password"
                value={openRouterKey}
                onChange={(e) => setOpenRouterKey(e.target.value)}
                placeholder={
                  apiKeyConfigured ? "Paste a replacement key" : "sk-or-..."
                }
                className="h-8 w-full rounded-md border border-[var(--border-subtle)] bg-white pl-7 pr-2 text-[12px] text-[var(--ink-900)] focus:border-[var(--accent-500)] focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={saveOpenRouter}
              disabled={savingOpenRouter}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-[var(--accent-600)] px-2.5 text-[11px] font-semibold text-white transition hover:bg-[var(--accent-700)] disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              Save
            </button>
          </div>

          <label className="block">
            <span className="text-[10.5px] font-medium text-[var(--ink-600)]">
              Model slug
            </span>
            <input
              type="text"
              value={openRouterModel}
              onChange={(e) => setOpenRouterModel(e.target.value)}
              onBlur={() => void saveOpenRouter()}
              className="mt-1 h-8 w-full rounded-md border border-[var(--border-subtle)] bg-white px-2 text-[12px] text-[var(--ink-900)] focus:border-[var(--accent-500)] focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-1.5">
            <label className="block min-w-0">
              <span className="text-[10.5px] font-medium text-[var(--ink-600)]">
                Endpoint
              </span>
              <input
                type="text"
                value={openRouterBaseUrl}
                onChange={(e) => setOpenRouterBaseUrl(e.target.value)}
                onBlur={() => void saveOpenRouter()}
                className="mt-1 h-8 w-full rounded-md border border-[var(--border-subtle)] bg-white px-2 text-[12px] text-[var(--ink-900)] focus:border-[var(--accent-500)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10.5px] font-medium text-[var(--ink-600)]">
                Max tokens
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={openRouterMaxTokens}
                onChange={(e) => setOpenRouterMaxTokens(e.target.value)}
                onBlur={() => void saveOpenRouter()}
                placeholder="auto"
                className="mt-1 h-8 w-full rounded-md border border-[var(--border-subtle)] bg-white px-2 text-right text-[12px] text-[var(--ink-900)] focus:border-[var(--accent-500)] focus:outline-none"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Auto-generate toggle */}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={autoGenerate}
          onClick={() => onAutoGenerate(!autoGenerate)}
          className={`mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
            autoGenerate
              ? "bg-[var(--accent-600)]"
              : "bg-[var(--surface-sunken)] ring-1 ring-inset ring-[var(--border-default)]"
          }`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
              autoGenerate ? "translate-x-3.5" : "translate-x-0.5"
            }`}
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-[var(--ink-900)]">
            Auto-generate visualizations
          </p>
          <p className="text-[11px] leading-relaxed text-[var(--ink-500)]">
            {autoGenerate
              ? "Every detected tag fires its viz generation in parallel."
              : "Tags appear after detection but only render on click."}
          </p>
        </div>
      </div>

      {/* Max retries number input */}
      <div className="flex items-start gap-2.5 border-t border-[var(--border-subtle)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-[var(--ink-900)]">
            Max viz repair attempts
          </p>
          <p className="text-[11px] leading-relaxed text-[var(--ink-500)]">
            Extra calls after a runtime error. Total attempts per tag = 1 + this.
          </p>
        </div>
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={maxRetries}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 0) onMaxRetries(n);
          }}
          className="h-7 w-14 shrink-0 rounded-md border border-[var(--border-subtle)] bg-white px-2 text-right text-[12.5px] font-medium tabular-nums text-[var(--ink-900)] focus:border-[var(--accent-500)] focus:outline-none"
        />
      </div>
    </>
  );
}
