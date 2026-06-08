/**
 * Persistent app settings.
 *
 * Source of truth for runtime knobs the user can toggle from the
 * Settings popover. Saved settings live at <DATA_DIR>/settings.json so
 * they survive app restarts, OS reboots, and the dynamic localhost port
 * that changes between Electron launches.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { AUTO_GENERATE_VIZ, MAX_VIZ_GEN_RETRIES } from "./config";

export type AiProvider = "codex" | "openrouter";
export type AiProviderPreference = "auto" | AiProvider;
export type OpenRouterKeySource = "local" | "environment" | null;

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

export type OpenRouterSettings = {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number | null;
};

export type AppSettings = {
  autoGenerate: boolean;
  maxRetries: number;
  aiProvider: AiProviderPreference;
  openRouter: OpenRouterSettings;
};

export type ResolvedOpenRouterSettings = OpenRouterSettings & {
  apiKeyConfigured: boolean;
  apiKeySource: OpenRouterKeySource;
};

export type PublicSettings = {
  autoGenerate: boolean;
  maxRetries: number;
  aiProvider: AiProviderPreference;
  resolvedProvider: AiProvider;
  openRouter: Omit<OpenRouterSettings, "apiKey"> & {
    apiKeyConfigured: boolean;
    apiKeySource: OpenRouterKeySource;
  };
};

const VERSION = 1 as const;
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

function providerFromEnv(): AiProvider | null {
  const raw = String(
    process.env.GETIT_AI_PROVIDER ?? process.env.GETIT_LLM_PROVIDER ?? "",
  )
    .trim()
    .toLowerCase();
  return raw === "openrouter" || raw === "codex" ? raw : null;
}

function cleanString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanMaxTokens(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function cleanProviderPreference(value: unknown): AiProviderPreference {
  return value === "auto" || value === "codex" || value === "openrouter"
    ? value
    : "auto";
}

function defaultsFromEnv(): AppSettings {
  return {
    autoGenerate: AUTO_GENERATE_VIZ,
    maxRetries: MAX_VIZ_GEN_RETRIES,
    aiProvider: "auto",
    openRouter: {
      apiKey: "",
      model: cleanString(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL),
      baseUrl: cleanString(
        process.env.OPENROUTER_BASE_URL,
        DEFAULT_OPENROUTER_BASE_URL,
      ),
      maxTokens: cleanMaxTokens(process.env.OPENROUTER_MAX_TOKENS),
    },
  };
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { v: number } & Partial<AppSettings>;
    if (parsed && parsed.v === VERSION) {
      const env = defaultsFromEnv();
      const storedOpenRouter =
        parsed.openRouter && typeof parsed.openRouter === "object"
          ? (parsed.openRouter as Partial<OpenRouterSettings>)
          : {};
      return {
        autoGenerate:
          typeof parsed.autoGenerate === "boolean"
            ? parsed.autoGenerate
            : env.autoGenerate,
        maxRetries:
          typeof parsed.maxRetries === "number" && parsed.maxRetries >= 0
            ? Math.min(10, Math.floor(parsed.maxRetries))
            : env.maxRetries,
        aiProvider: cleanProviderPreference(parsed.aiProvider),
        openRouter: {
          apiKey: cleanSecret(storedOpenRouter.apiKey),
          model: cleanString(storedOpenRouter.model, env.openRouter.model),
          baseUrl: cleanString(storedOpenRouter.baseUrl, env.openRouter.baseUrl),
          maxTokens:
            cleanMaxTokens(storedOpenRouter.maxTokens) ?? env.openRouter.maxTokens,
        },
      };
    }
  } catch {
    /* file missing or malformed; fall through to env defaults */
  }
  return defaultsFromEnv();
}

export function saveSettings(s: AppSettings): void {
  const env = defaultsFromEnv();
  const file = {
    v: VERSION,
    savedAt: Date.now(),
    autoGenerate: !!s.autoGenerate,
    maxRetries: Math.min(10, Math.max(0, Math.floor(s.maxRetries))),
    aiProvider: cleanProviderPreference(s.aiProvider),
    openRouter: {
      apiKey: cleanSecret(s.openRouter?.apiKey),
      model: cleanString(s.openRouter?.model, env.openRouter.model),
      baseUrl: cleanString(s.openRouter?.baseUrl, env.openRouter.baseUrl),
      maxTokens: cleanMaxTokens(s.openRouter?.maxTokens),
    },
  };
  const tmp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
}

export function resolveOpenRouterSettings(
  s: AppSettings = loadSettings(),
): ResolvedOpenRouterSettings {
  const localKey = cleanSecret(s.openRouter.apiKey);
  const envKey = cleanSecret(process.env.OPENROUTER_API_KEY);
  const apiKey = localKey || envKey;
  const apiKeySource: OpenRouterKeySource = localKey
    ? "local"
    : envKey
      ? "environment"
      : null;

  return {
    ...s.openRouter,
    apiKey,
    apiKeyConfigured: !!apiKey,
    apiKeySource,
  };
}

export function resolveAiProvider(s: AppSettings = loadSettings()): AiProvider {
  if (s.aiProvider === "codex" || s.aiProvider === "openrouter") {
    return s.aiProvider;
  }
  const explicitEnv = providerFromEnv();
  if (explicitEnv) return explicitEnv;
  return resolveOpenRouterSettings(s).apiKeyConfigured ? "openrouter" : "codex";
}

export function toPublicSettings(
  s: AppSettings = loadSettings(),
): PublicSettings {
  const openRouter = resolveOpenRouterSettings(s);
  return {
    autoGenerate: s.autoGenerate,
    maxRetries: s.maxRetries,
    aiProvider: s.aiProvider,
    resolvedProvider: resolveAiProvider(s),
    openRouter: {
      model: openRouter.model,
      baseUrl: openRouter.baseUrl,
      maxTokens: openRouter.maxTokens,
      apiKeyConfigured: openRouter.apiKeyConfigured,
      apiKeySource: openRouter.apiKeySource,
    },
  };
}
