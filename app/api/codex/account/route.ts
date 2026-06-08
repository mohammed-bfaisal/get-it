/**
 * GET /api/codex/account
 *
 * Returns the currently-authenticated ChatGPT/Codex account + the
 * latest 5-hour and weekly rate-limit windows. Fully resilient — any
 * piece that can't be fetched comes back as null so the UI renders
 * "no data" instead of crashing.
 *
 * No network call is made for account info (decoded locally from the
 * JWT in ~/.codex/auth.json). Rate limits use codex's own
 * `account/rateLimits/read` JSON-RPC method via `codex app-server`.
 */

import { NextResponse } from "next/server";
import {
  readAccountInfo,
  readRateLimits,
  type CodexAccountInfo,
  type CodexRateLimits,
} from "@/lib/codex-account";
import { getAiProvider, getOpenRouterRuntimeInfo } from "@/lib/codex";

export const runtime = "nodejs";

export async function GET() {
  const provider = getAiProvider();
  if (provider === "openrouter") {
    return NextResponse.json({
      provider,
      openRouter: getOpenRouterRuntimeInfo(),
      account: null,
      rateLimits: null,
    });
  }

  const account: CodexAccountInfo | null = (() => {
    try {
      return readAccountInfo();
    } catch {
      return null;
    }
  })();
  let limits: CodexRateLimits | null = null;
  try {
    limits = await readRateLimits();
  } catch {
    limits = null;
  }
  return NextResponse.json({ provider, account, rateLimits: limits });
}
