import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "get-it-provider-"));
process.env.GETIT_DATA_DIR = dataDir;

const settingsPath = path.join(dataDir, "settings.json");
let settings: typeof import("../lib/settings-store.ts");

before(async () => {
  settings = await import("../lib/settings-store.ts");
});

beforeEach(() => {
  fs.rmSync(settingsPath, { force: true });
  delete process.env.GETIT_AI_PROVIDER;
  delete process.env.GETIT_LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
});

test("public settings report no local OpenRouter key until one is saved", () => {
  const publicSettings = settings.toPublicSettings(settings.loadSettings());

  assert.equal(publicSettings.openRouter.apiKeyConfigured, false);
  assert.equal(publicSettings.openRouter.apiKeySource, null);
  assert.equal("apiKey" in publicSettings.openRouter, false);
});

test("local OpenRouter settings can store a secret key and custom model slug", () => {
  const current = settings.loadSettings();

  settings.saveSettings({
    ...current,
    aiProvider: "openrouter",
    openRouter: {
      ...current.openRouter,
      apiKey: "sk-or-local",
      model: "nousresearch/hermes-3-llama-3.1-405b",
    },
  });

  const loaded = settings.loadSettings();
  const runtime = settings.resolveOpenRouterSettings(loaded);
  const publicSettings = settings.toPublicSettings(loaded);

  assert.equal(settings.resolveAiProvider(loaded), "openrouter");
  assert.equal(runtime.apiKey, "sk-or-local");
  assert.equal(runtime.apiKeySource, "local");
  assert.equal(runtime.model, "nousresearch/hermes-3-llama-3.1-405b");
  assert.equal(publicSettings.openRouter.apiKeyConfigured, true);
  assert.equal(publicSettings.openRouter.apiKeySource, "local");
  assert.equal(publicSettings.openRouter.model, "nousresearch/hermes-3-llama-3.1-405b");
  assert.equal("apiKey" in publicSettings.openRouter, false);
});

test("environment OpenRouter keys are labelled separately from localhost keys", () => {
  process.env.OPENROUTER_API_KEY = "sk-or-env";

  const runtime = settings.resolveOpenRouterSettings(settings.loadSettings());
  const publicSettings = settings.toPublicSettings(settings.loadSettings());

  assert.equal(runtime.apiKey, "sk-or-env");
  assert.equal(runtime.apiKeySource, "environment");
  assert.equal(publicSettings.openRouter.apiKeyConfigured, true);
  assert.equal(publicSettings.openRouter.apiKeySource, "environment");
  assert.equal("apiKey" in publicSettings.openRouter, false);
});
