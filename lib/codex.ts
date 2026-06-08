/**
 * Thin wrapper around @openai/codex-sdk that gives us:
 *   - lazily-initialized singleton
 *   - sane defaults for "answer-only" mode (read-only sandbox, no approvals,
 *     web search off by default)
 *   - a `runJson` helper that runs a one-shot turn against an output-schema
 *     and returns the parsed JSON, with retry-on-parse-failure
 *   - structured CodexError classification (auth lost vs rate-limit vs
 *     generic). Every agent call funnels through here, so the rest of the
 *     app gets a single, stable shape to display.
 *
 * Note on the Codex binary: in packaged Electron builds the main process
 * resolves the bundled binary and exposes its absolute path through
 * CODEX_BINARY_PATH. Passing that path to the SDK avoids fragile
 * node_modules lookup from the standalone Next server.
 */

import { Codex } from "@openai/codex-sdk";
import type { ThreadOptions } from "@openai/codex-sdk";
import { CODEX_SCRATCH_DIR } from "./paths";
import {
  resolveAiProvider,
  resolveOpenRouterSettings,
  type AiProvider,
  type OpenRouterKeySource,
} from "./settings-store";

export type { AiProvider } from "./settings-store";

const DEFAULT_OPENROUTER_TITLE = "Get It";

let _codex: Codex | null = null;

function openRouterApiKey(): string {
  return resolveOpenRouterSettings().apiKey;
}

export function getAiProvider(): AiProvider {
  return resolveAiProvider();
}

function openRouterModel(): string {
  return resolveOpenRouterSettings().model;
}

function openRouterBaseUrl(): string {
  return resolveOpenRouterSettings().baseUrl;
}

function openRouterChatUrl(): string {
  const base = openRouterBaseUrl()
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function openRouterMaxTokens(): number | undefined {
  return resolveOpenRouterSettings().maxTokens ?? undefined;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "").slice(0, 240);
}

export type OpenRouterRuntimeInfo = {
  model: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeySource: OpenRouterKeySource;
};

export function getOpenRouterRuntimeInfo(): OpenRouterRuntimeInfo {
  const openRouter = resolveOpenRouterSettings();
  return {
    model: openRouter.model,
    baseUrl: openRouter.baseUrl,
    apiKeyConfigured: openRouter.apiKeyConfigured,
    apiKeySource: openRouter.apiKeySource,
  };
}

function getCodex(): Codex {
  if (_codex) return _codex;
  const codexPathOverride = process.env.CODEX_BINARY_PATH;
  _codex = new Codex({
    ...(codexPathOverride ? { codexPathOverride } : {}),
    config: {
      // disable image generation so we can use 'low' reasoning; the demo is
      // text-only so there is nothing to lose.
      tools: { image_gen: false },
    },
  });
  return _codex;
}

export type RunOptions = {
  /** Defaults to "low" — fastest answer-only model setting that allows tools=image_gen=false. */
  reasoning?: "low" | "medium" | "high";
  /** Allow live web search for this call (e.g. legal citations). */
  webSearch?: boolean;
  /** AbortSignal forwarded to the underlying child process. */
  signal?: AbortSignal;
  /** Override default thread options. */
  threadOverrides?: Partial<ThreadOptions>;
};

function threadOptions(opts: RunOptions = {}): ThreadOptions {
  return {
    sandboxMode: "read-only",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    workingDirectory: CODEX_SCRATCH_DIR,
    modelReasoningEffort: opts.reasoning ?? "low",
    webSearchEnabled: opts.webSearch ?? false,
    ...(opts.threadOverrides ?? {}),
  };
}

function buildThread(opts: RunOptions = {}) {
  return getCodex().startThread(threadOptions(opts));
}

/** Strip markdown code fences the model sometimes wraps JSON in, then parse. */
function parseTurnJson<T>(finalResponse: string | undefined): T {
  const text = finalResponse?.trim();
  if (!text) throw new Error("Empty finalResponse from codex");
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

/**
 * Error kinds that we want the UI to react to differently. Anything not
 * one of these stays `generic`; the calling code can still surface the
 * raw message but the banner won't claim a rate-limit when there isn't one.
 */
export type CodexErrorKind =
  | "auth_lost" // user is not logged in (or token revoked)
  | "rate_limit" // hit the 5h or weekly window
  | "binary_missing" // the codex binary itself can't be found
  | "generic";

export class CodexError extends Error {
  readonly kind: CodexErrorKind;
  /**
   * If `kind === "rate_limit"` and the model gave us a deadline,
   * `retryAt` is a unix-ms timestamp the UI can count down to. Optional;
   * the wrapper falls back to a phrased message when no deadline is
   * available.
   */
  readonly retryAt?: number;
  /**
   * Coarse window the rate limit belongs to, when the message tells us.
   * "5h" or "weekly" — the same labels the codex TUI uses. Falls back to
   * "unknown" if we can't tell.
   */
  readonly window?: "5h" | "weekly" | "unknown";

  constructor(
    kind: CodexErrorKind,
    message: string,
    extras?: { retryAt?: number; window?: "5h" | "weekly" | "unknown" },
  ) {
    super(message);
    this.name = "CodexError";
    this.kind = kind;
    this.retryAt = extras?.retryAt;
    this.window = extras?.window;
  }
}

// ── Health mailbox ──────────────────────────────────────────────────────
// Process-local snapshot of the most recent CodexError. The UI polls
// /api/codex/health to render a banner with a countdown + reconnect
// button. We also use it to short-circuit calls while a rate limit is
// still active — no point hammering the API.
export type CodexHealth = {
  ok: boolean;
  provider: AiProvider;
  kind: CodexErrorKind | null;
  message: string | null;
  retryAt: number | null;
  window: "5h" | "weekly" | "unknown" | null;
  /** Monotone counter — UI uses this to detect "a new error came in" vs
   *  "still the same one I'm already showing". */
  serial: number;
  /** Last successful Codex call timestamp (epoch ms). */
  lastOkAt: number | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __getitCodexHealth: CodexHealth | undefined;
}

const _initialHealth: CodexHealth = {
  ok: true,
  provider: getAiProvider(),
  kind: null,
  message: null,
  retryAt: null,
  window: null,
  serial: 0,
  lastOkAt: null,
};

const health: CodexHealth =
  globalThis.__getitCodexHealth ??
  (globalThis.__getitCodexHealth = { ..._initialHealth });

export function getCodexHealth(): CodexHealth {
  health.provider = getAiProvider();
  // If a rate-limit retry deadline has passed, auto-clear so the UI
  // stops showing the banner without a server round-trip.
  if (
    health.kind === "rate_limit" &&
    health.retryAt != null &&
    Date.now() >= health.retryAt
  ) {
    Object.assign(health, _initialHealth, { serial: health.serial });
  }
  return { ...health };
}

function markOk() {
  if (!health.ok) {
    Object.assign(health, _initialHealth, { serial: health.serial + 1 });
  }
  health.provider = getAiProvider();
  health.lastOkAt = Date.now();
  health.ok = true;
}

function markError(err: CodexError) {
  health.ok = false;
  health.provider = getAiProvider();
  health.kind = err.kind;
  health.message = err.message;
  health.retryAt = err.retryAt ?? null;
  health.window = err.window ?? null;
  health.serial += 1;
}

function preflightHealth(): CodexError | null {
  if (
    health.kind === "rate_limit" &&
    health.retryAt != null &&
    Date.now() < health.retryAt
  ) {
    return new CodexError("rate_limit", health.message ?? "Rate limit active", {
      retryAt: health.retryAt,
      window: health.window ?? "unknown",
    });
  }
  return null;
}

const RX_RATE_LIMIT =
  /(rate.?limit|usage limit|too many requests|429|quota|you've hit|you have hit)/i;
const RX_TRY_AGAIN_SECONDS = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i;
const RX_TRY_AGAIN_MIN = /try again in\s*(\d+(?:\.\d+)?)\s*(m|mins?|minutes?)/i;
const RX_TRY_AGAIN_HOUR = /try again in\s*(\d+(?:\.\d+)?)\s*(h|hrs?|hours?)/i;
const RX_AUTH = /(not logged in|please.*log ?in|unauthori[sz]ed|401|invalid api key|token (?:has )?expired|sign in)/i;
const RX_BINARY = /(unable to locate codex|cannot find module|enoent.*codex|codex.*not found|spawn .* enoent)/i;
const RX_WEEKLY = /\bweekly\b/i;
const RX_FIVE_H = /\b(5\s*h|5\s*hour|five hour)\b/i;

export function classifyCodexError(err: unknown): CodexError {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Codex call failed";

  if (RX_BINARY.test(msg)) {
    return new CodexError("binary_missing", msg);
  }

  if (RX_AUTH.test(msg)) {
    return new CodexError("auth_lost", msg);
  }

  if (RX_RATE_LIMIT.test(msg)) {
    let retryAt: number | undefined;
    const sec = RX_TRY_AGAIN_SECONDS.exec(msg);
    const min = RX_TRY_AGAIN_MIN.exec(msg);
    const hr = RX_TRY_AGAIN_HOUR.exec(msg);
    if (sec) {
      const unit = sec[2].toLowerCase();
      const value = Number(sec[1]);
      const ms = unit.startsWith("ms") ? value : value * 1000;
      retryAt = Date.now() + ms;
    } else if (min) {
      retryAt = Date.now() + Number(min[1]) * 60_000;
    } else if (hr) {
      retryAt = Date.now() + Number(hr[1]) * 3_600_000;
    }
    const window: "5h" | "weekly" | "unknown" = RX_WEEKLY.test(msg)
      ? "weekly"
      : RX_FIVE_H.test(msg)
        ? "5h"
        : "unknown";
    return new CodexError("rate_limit", msg, { retryAt, window });
  }

  return new CodexError("generic", msg);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Date.now() + seconds * 1000;
  }
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? absolute : undefined;
}

function openRouterErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown; code?: unknown };
    };
    const message = parsed.error?.message;
    const code = parsed.error?.code;
    if (typeof message === "string" && typeof code === "string") {
      return `OpenRouter ${status} (${code}): ${message}`;
    }
    if (typeof message === "string") return `OpenRouter ${status}: ${message}`;
  } catch {
    /* use the raw body below */
  }
  const tail = bodyText.trim().slice(0, 800);
  return tail ? `OpenRouter ${status}: ${tail}` : `OpenRouter ${status}`;
}

function classifyOpenRouterResponse(
  status: number,
  bodyText: string,
  retryAfter: string | null,
): CodexError {
  const message = openRouterErrorMessage(status, bodyText);
  if (status === 401 || status === 403) {
    return new CodexError("auth_lost", message);
  }
  if (status === 429) {
    return new CodexError("rate_limit", message, {
      retryAt: parseRetryAfter(retryAfter),
      window: "unknown",
    });
  }
  return classifyCodexError(message);
}

function requireOpenRouterApiKey(): string {
  const key = openRouterApiKey();
  if (!key) {
    throw new CodexError(
      "auth_lost",
      "OpenRouter API key is not set. Save one in Settings, or set OPENROUTER_API_KEY in your shell environment.",
    );
  }
  return key;
}

function openRouterContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

async function requestOpenRouterJson<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions,
): Promise<{ data: T; usage: unknown }> {
  const apiKey = requireOpenRouterApiKey();
  const maxTokens = openRouterMaxTokens();
  const plugins = [
    ...(opts.webSearch ? [{ id: "web" }] : []),
    { id: "response-healing" },
  ];
  const referer = (
    process.env.OPENROUTER_HTTP_REFERER ??
    process.env.OPENROUTER_REFERER ??
    "https://github.com/beltromatti/get-it"
  ).trim();
  const title = (
    process.env.OPENROUTER_APP_TITLE ??
    process.env.OPENROUTER_TITLE ??
    DEFAULT_OPENROUTER_TITLE
  ).trim();

  const response = await fetch(openRouterChatUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": safeHeaderValue(referer),
      "X-OpenRouter-Title": safeHeaderValue(title),
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: openRouterModel(),
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "get_it_response",
          strict: true,
          schema: outputSchema,
        },
      },
      provider: { require_parameters: true },
      plugins,
      stream: false,
      temperature: 0.2,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw classifyOpenRouterResponse(
      response.status,
      bodyText,
      response.headers.get("retry-after"),
    );
  }
  let body: {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: unknown;
  };
  try {
    body = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: unknown;
    };
  } catch (err) {
    throw new Error(`OpenRouter returned non-JSON response: ${(err as Error).message}`);
  }
  const finalResponse = openRouterContentToText(body.choices?.[0]?.message?.content);
  return { data: parseTurnJson<T>(finalResponse), usage: body.usage ?? null };
}

async function runOpenRouterJson<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions = {},
): Promise<{ data: T; usage: unknown }> {
  const preflight = preflightHealth();
  if (preflight) throw preflight;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await requestOpenRouterJson<T>(prompt, outputSchema, opts);
      markOk();
      return result;
    } catch (err) {
      lastErr = err;
      const classified = err instanceof CodexError ? err : classifyCodexError(err);
      if (classified.kind !== "generic") {
        markError(classified);
        throw classified;
      }
    }
  }
  const finalErr = classifyCodexError(lastErr);
  if (finalErr.kind !== "generic") markError(finalErr);
  throw finalErr;
}

/**
 * Run a single turn that must return JSON conforming to the supplied schema.
 * Retries once if the model returns un-parseable text. Throws CodexError on
 * failure so callers can pattern-match on `.kind`.
 */
export async function runJson<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions = {},
): Promise<{ data: T; usage: unknown }> {
  if (getAiProvider() === "openrouter") {
    return runOpenRouterJson<T>(prompt, outputSchema, opts);
  }
  // Short-circuit: if we know we're inside a rate-limit window, fail fast
  // without burning another Codex call.
  const preflight = preflightHealth();
  if (preflight) throw preflight;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const thread = buildThread(opts);
    try {
      const turn = await thread.run(prompt, {
        outputSchema,
        signal: opts.signal,
      });
      const parsed = parseTurnJson<T>(turn.finalResponse);
      markOk();
      return { data: parsed, usage: turn.usage };
    } catch (err) {
      lastErr = err;
      const classified = classifyCodexError(err);
      // Auth/rate-limit/binary failures: don't bother retrying — the
      // condition isn't going to clear in 200ms. Bubble up immediately so
      // the in-app banner can take over.
      if (classified.kind !== "generic") {
        markError(classified);
        throw classified;
      }
    }
  }
  const finalErr = classifyCodexError(lastErr);
  if (finalErr.kind !== "generic") markError(finalErr);
  throw finalErr;
}

/**
 * Thread-aware JSON runner for multi-turn tools (chat).
 *
 * Two modes, exactly one of which must be supplied:
 *   • start  — open a NEW thread and send the full first-turn prompt (system
 *              + document + history). Returns the new `threadId` to persist.
 *              Retries once on a parse blip, like runJson.
 *   • resume — continue an EXISTING thread by `threadId`, sending only the new
 *              turn input. The model still has the document + prior turns in
 *              its own context, so we don't resend them (and the stable prefix
 *              is a guaranteed cache hit). No internal retry: on any generic
 *              failure (including a lost/expired session) the caller falls
 *              back to `start` with full context, so a resume never silently
 *              degrades the answer.
 *
 * Rate-limit / auth / binary errors are classified and thrown immediately in
 * both modes so the health banner takes over.
 */
export async function runJsonInThread<T>(args: {
  outputSchema: object;
  opts?: RunOptions;
  resume?: { threadId: string; input: string };
  start?: { input: string };
}): Promise<{ data: T; usage: unknown; threadId: string | null }> {
  if (getAiProvider() === "openrouter") {
    if (args.resume) {
      throw new CodexError(
        "generic",
        "OpenRouter transport is stateless; rebuild the conversation from local history.",
      );
    }
    if (!args.start) throw new Error("runJsonInThread: provide `start` or `resume`");
    const { data, usage } = await runOpenRouterJson<T>(
      args.start.input,
      args.outputSchema,
      args.opts ?? {},
    );
    return { data, usage, threadId: null };
  }

  const preflight = preflightHealth();
  if (preflight) throw preflight;
  const opts = args.opts ?? {};

  if (args.resume) {
    const thread = getCodex().resumeThread(args.resume.threadId, threadOptions(opts));
    try {
      const turn = await thread.run(args.resume.input, {
        outputSchema: args.outputSchema,
        signal: opts.signal,
      });
      const parsed = parseTurnJson<T>(turn.finalResponse);
      markOk();
      return { data: parsed, usage: turn.usage, threadId: thread.id ?? args.resume.threadId };
    } catch (err) {
      const classified = classifyCodexError(err);
      if (classified.kind !== "generic") markError(classified);
      throw classified;
    }
  }

  if (!args.start) throw new Error("runJsonInThread: provide `start` or `resume`");

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const thread = buildThread(opts);
    try {
      const turn = await thread.run(args.start.input, {
        outputSchema: args.outputSchema,
        signal: opts.signal,
      });
      const parsed = parseTurnJson<T>(turn.finalResponse);
      markOk();
      return { data: parsed, usage: turn.usage, threadId: thread.id };
    } catch (err) {
      lastErr = err;
      const classified = classifyCodexError(err);
      if (classified.kind !== "generic") {
        markError(classified);
        throw classified;
      }
    }
  }
  const finalErr = classifyCodexError(lastErr);
  if (finalErr.kind !== "generic") markError(finalErr);
  throw finalErr;
}
