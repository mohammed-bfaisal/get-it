/**
 * GET  /api/settings    → current persisted AppSettings (or env defaults)
 * POST /api/settings    → merge body into persisted settings
 *
 * The viewer reads this once at mount and writes on every toggle. Settings
 * survive app restarts because they live at <DATA_DIR>/settings.json.
 */

import { NextResponse } from "next/server";
import {
  loadSettings,
  saveSettings,
  toPublicSettings,
  type AiProviderPreference,
  type AppSettings,
} from "@/lib/settings-store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(toPublicSettings(loadSettings()));
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  type SettingsBody = Partial<Omit<AppSettings, "openRouter">> & {
    openRouter?: Partial<AppSettings["openRouter"]> & {
      clearApiKey?: boolean;
    };
  };
  const b = (body && typeof body === "object" ? body : {}) as SettingsBody;
  const current = loadSettings();
  type OpenRouterUpdate = NonNullable<SettingsBody["openRouter"]>;
  const provider =
    b.aiProvider === "auto" ||
    b.aiProvider === "codex" ||
    b.aiProvider === "openrouter"
      ? (b.aiProvider as AiProviderPreference)
      : current.aiProvider;
  const incomingOpenRouter: OpenRouterUpdate =
    b.openRouter && typeof b.openRouter === "object" ? b.openRouter : {};
  const nextApiKey =
    incomingOpenRouter.clearApiKey === true
      ? ""
      : typeof incomingOpenRouter.apiKey === "string"
        ? incomingOpenRouter.apiKey
        : current.openRouter.apiKey;
  const next: AppSettings = {
    autoGenerate:
      typeof b.autoGenerate === "boolean" ? b.autoGenerate : current.autoGenerate,
    maxRetries:
      typeof b.maxRetries === "number" && b.maxRetries >= 0
        ? b.maxRetries
        : current.maxRetries,
    aiProvider: provider,
    openRouter: {
      apiKey: nextApiKey,
      model:
        typeof incomingOpenRouter.model === "string"
          ? incomingOpenRouter.model
          : current.openRouter.model,
      baseUrl:
        typeof incomingOpenRouter.baseUrl === "string"
          ? incomingOpenRouter.baseUrl
          : current.openRouter.baseUrl,
      maxTokens:
        incomingOpenRouter.maxTokens === null ||
        typeof incomingOpenRouter.maxTokens === "number"
          ? incomingOpenRouter.maxTokens
          : current.openRouter.maxTokens,
    },
  };
  saveSettings(next);
  return NextResponse.json(toPublicSettings(loadSettings()));
}
