import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Model } from "@mariozechner/pi-ai";

interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
}

interface PiModelConfig {
  id: string;
  api: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  compat?: Record<string, unknown>;
}

interface PiProviderConfig {
  apiKey: string; // 环境变量名
  baseUrl: string;
  models: PiModelConfig[];
}

interface PiModelsFile {
  providers: Record<string, PiProviderConfig>;
}

const PI_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");

export function resolveConfiguredApiKey(apiKeyConfig: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return apiKeyConfig.startsWith("sk-") ? apiKeyConfig : env[apiKeyConfig];
}

export async function loadPiConfig(): Promise<{
  model: Model<any>;
  apiKeyEnvVar: string;
}> {
  const settingsPath = path.join(PI_CONFIG_DIR, "settings.json");
  const modelsPath = path.join(PI_CONFIG_DIR, "models.json");

  const [settingsRaw, modelsRaw] = await Promise.all([
    fs.readFile(settingsPath, "utf-8").catch(() => null),
    fs.readFile(modelsPath, "utf-8").catch(() => null),
  ]);

  if (!settingsRaw || !modelsRaw) {
    throw new Error(
      `Pi config not found in ${PI_CONFIG_DIR}. Expected settings.json and models.json.`,
    );
  }

  const settings: PiSettings = JSON.parse(settingsRaw);
  const modelsConfig: PiModelsFile = JSON.parse(modelsRaw);

  const providerName = settings.defaultProvider;
  const modelId = settings.defaultModel;

  if (!providerName || !modelId) {
    throw new Error(
      `Pi config missing defaultProvider or defaultModel in settings.json`,
    );
  }

  const providerConfig = modelsConfig.providers[providerName];
  if (!providerConfig) {
    throw new Error(
      `Provider "${providerName}" not found in models.json`,
    );
  }

  const modelConfig = providerConfig.models.find((m) => m.id === modelId);
  if (!modelConfig) {
    throw new Error(
      `Model "${modelId}" not found in provider "${providerName}"`,
    );
  }

  const apiKeyEnvVar = providerConfig.apiKey;
  const apiKey = resolveConfiguredApiKey(apiKeyEnvVar);
  if (!apiKey) {
    throw new Error(
      `API key is not set: ${apiKeyEnvVar}`,
    );
  }

  const model: Model<any> = {
    id: modelConfig.id,
    name: modelConfig.name,
    api: modelConfig.api as any,
    provider: providerName,
    baseUrl: providerConfig.baseUrl,
    reasoning: modelConfig.reasoning,
    input: modelConfig.input as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelConfig.contextWindow,
    maxTokens: modelConfig.maxTokens,
    compat: modelConfig.compat as any,
  };

  return { model, apiKeyEnvVar };
}

export async function listPiModels(): Promise<void> {
  const modelsPath = path.join(PI_CONFIG_DIR, "models.json");
  const raw = await fs.readFile(modelsPath, "utf-8").catch(() => null);
  if (!raw) {
    console.error(`No models.json found in ${PI_CONFIG_DIR}`);
    return;
  }

  const config: PiModelsFile = JSON.parse(raw);
  for (const [providerName, provider] of Object.entries(config.providers)) {
    console.log(`\n${providerName} (${provider.baseUrl}):`);
    for (const m of provider.models) {
      console.log(`  ${m.id} — ${m.name} [${m.api}]`);
    }
  }
}
