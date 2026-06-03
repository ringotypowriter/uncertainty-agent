import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { runPipeline } from "./pipeline.js";
import { loadPiConfig, listPiModels, resolveConfiguredApiKey } from "./config/pi-config.js";
import type { Model } from "@mariozechner/pi-ai";
import type { StageId, UncertaintyContext } from "./stages.js";
import { getStageContextFields, getStageOrder, loadWorkflowConfig } from "./workflow-config.js";
import type { WorkflowConfig, WorkflowStage } from "./workflow-config.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

registerBuiltInApiProviders();

interface PiModelEntry {
  id: string;
  api: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  compat?: Record<string, unknown>;
}

interface PiProviderEntry {
  apiKey: string;
  baseUrl: string;
  models: PiModelEntry[];
}

interface PiModelsFile {
  providers: Record<string, PiProviderEntry>;
}

async function resolveModel(modelOverride?: string): Promise<{ model: Model<any>; apiKeyEnvVar: string }> {
  if (!modelOverride) return loadPiConfig();

  const sep = modelOverride.includes("/") ? "/" : ":";
  const [providerName, modelId] = modelOverride.split(sep);
  if (!providerName || !modelId) {
    throw new Error(`Invalid model format: ${modelOverride}. Use provider/model-id.`);
  }

  const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const raw = await fs.readFile(modelsPath, "utf-8");
  const config: PiModelsFile = JSON.parse(raw);

  const provider = config.providers[providerName];
  if (!provider) throw new Error(`Provider "${providerName}" not found in ${modelsPath}`);

  const modelConfig = provider.models.find((m) => m.id === modelId);
  if (!modelConfig) throw new Error(`Model "${modelId}" not found in provider "${providerName}"`);

  const model: Model<any> = {
    id: modelConfig.id,
    name: modelConfig.name,
    api: modelConfig.api as any,
    provider: providerName,
    baseUrl: provider.baseUrl,
    reasoning: modelConfig.reasoning,
    input: modelConfig.input as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelConfig.contextWindow,
    maxTokens: modelConfig.maxTokens,
    compat: modelConfig.compat as any,
  };

  return { model, apiKeyEnvVar: provider.apiKey };
}

function generateRunId(inputPath: string): string {
  const basename = path.basename(inputPath, path.extname(inputPath));
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "").replace("T", "_");
  return `${basename}_${ts}`;
}

async function findLatestRun(inputPath: string, outputDir: string, excludeForks = true): Promise<string | null> {
  const basename = path.basename(inputPath, path.extname(inputPath));
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(basename + "_") && !(excludeForks && e.name.includes("_fork-")))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const dir of dirs) {
    const ctxPath = path.join(outputDir, dir, "context.json");
    try {
      await fs.access(ctxPath);
      return path.join(outputDir, dir);
    } catch { /* skip */ }
  }
  return null;
}

function valuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

function stageComplete(ctx: UncertaintyContext, stage: WorkflowStage): boolean {
  return getStageContextFields(stage).every((field) => valuePresent((ctx as any)[field]));
}

function collectCompletedStages(ctx: UncertaintyContext, workflow: WorkflowConfig): StageId[] {
  return workflow.stages.filter((stage) => stageComplete(ctx, stage)).map((stage) => stage.id);
}

function collectCompletedPrefix(ctx: UncertaintyContext, workflow: WorkflowConfig, beforeStageNumber: number): StageId[] {
  const completed: StageId[] = [];
  for (let n = 1; n < beforeStageNumber; n++) {
    const stage = workflow.stages[n - 1];
    if (stageComplete(ctx, stage)) completed.push(stage.id);
    else break;
  }
  return completed;
}

function clearStageRange(ctx: UncertaintyContext, workflow: WorkflowConfig, startStageNumber: number, endStageNumber: number): void {
  for (let n = startStageNumber; n <= endStageNumber; n++) {
    const stage = workflow.stages[n - 1];
    for (const field of getStageContextFields(stage)) delete (ctx as any)[field];
  }
}

interface ResumeResult {
  runDir: string;
  completedStages: StageId[];
}

async function findLatestIncompleteRun(inputPath: string, outputDir: string, workflow: WorkflowConfig): Promise<ResumeResult | null> {
  const latest = await findLatestRun(inputPath, outputDir, false);
  if (!latest) return null;

  let ctx: UncertaintyContext;
  try {
    ctx = JSON.parse(await fs.readFile(path.join(latest, "context.json"), "utf-8"));
  } catch {
    return null;
  }

  const completed = collectCompletedStages(ctx, workflow);
  if (completed.length === workflow.stages.length) return null;
  return { runDir: latest, completedStages: completed };
}

interface StageSelector {
  index: number;
  display: string;
}

function stageDisplay(workflow: WorkflowConfig, index: number): string {
  return workflow.stages[index - 1]?.id ?? `#${index}`;
}

function stageRangeDisplay(workflow: WorkflowConfig, startIndex: number, endIndex: number): string {
  const start = stageDisplay(workflow, startIndex);
  const end = stageDisplay(workflow, endIndex);
  return start === end ? start : `${start}–${end}`;
}

function resolveStageSelector(value: string | undefined, workflow: WorkflowConfig): StageSelector | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  const exactIndex = workflow.stages.findIndex((stage) => stage.id === raw);
  if (exactIndex >= 0) return { index: exactIndex + 1, display: workflow.stages[exactIndex].id };

  if (/^\d+$/.test(raw)) {
    const parsed = parseInt(raw, 10);
    if (parsed >= 1 && parsed <= workflow.stages.length) {
      return { index: parsed, display: stageDisplay(workflow, parsed) };
    }
  }

  return { index: Number.NaN, display: raw };
}

function stageSelectorHelp(workflow: WorkflowConfig): string {
  return workflow.stages.map((stage, i) => `${i + 1} or ${stage.id}`).join(", ");
}

async function main() {
  const args = process.argv.slice(2);
  const workDir = process.cwd();
  const workflowArg = args.find((a) => a.startsWith("--workflow="))?.slice(11);
  const workflow = await loadWorkflowConfig(workDir, workflowArg);
  const stageOrder = getStageOrder(workflow);
  const stageCount = stageOrder.length;

  const inputFileArg = args.find((a) => a.startsWith("--input="))?.slice(8);
  const inputCwdArg = args.find((a) => a.startsWith("--input-cwd="))?.slice(12);
  const referenceQueryUrl = args.find((a) => a.startsWith("--reference-url="))?.slice(16)
    ?? process.env.REFERENCE_QUERY_URL
    ?? process.env.STANDARDRAG_QUERY_TREE_URL
    ?? "http://127.0.0.1:8000/query-tree";
  const modelOverride = args.find((a) => a.startsWith("--model="))?.slice(8);
  const runDirArg = args.find((a) => a.startsWith("--run-dir="))?.slice(10);
  const resume = args.includes("--resume");
  const forkOnly = args.includes("--fork-only");
  const fork = args.includes("--fork") || forkOnly;
  const startFrom = resolveStageSelector(args.find((a) => a.startsWith("--startFrom="))?.slice(12), workflow);
  const endAt = resolveStageSelector(args.find((a) => a.startsWith("--endAt="))?.slice(8), workflow);
  const extraPromptArg = args.find((a) => a.startsWith("--extra-prompt="))?.slice(15);

  if (args.includes("--list-models")) {
    await listPiModels();
    return;
  }

  if (startFrom !== undefined && (startFrom.index < 1 || startFrom.index > stageCount || isNaN(startFrom.index))) {
    console.error(`--startFrom must be one of: ${stageSelectorHelp(workflow)}`);
    process.exit(1);
  }
  if (endAt !== undefined && (endAt.index < 1 || endAt.index > stageCount || isNaN(endAt.index))) {
    console.error(`--endAt must be one of: ${stageSelectorHelp(workflow)}`);
    process.exit(1);
  }
  if (startFrom !== undefined && endAt !== undefined && startFrom.index > endAt.index) {
    console.error("--startFrom must be ≤ --endAt");
    process.exit(1);
  }
  if (fork && !resume && startFrom === undefined) {
    console.error("--fork requires --startFrom=N or --resume");
    process.exit(1);
  }

  if (!inputFileArg && !inputCwdArg) {
    console.error("Usage: bun run start -- --input=input/atomic-steps-testset-input/UA-001-balance-tare/procedure.md [--model=provider/model]");
    console.error("       bun run start -- --input-cwd=input/atomic-steps-testset-input/UA-001-balance-tare");
    console.error("       bun run start -- --list-models");
    process.exit(1);
  }

  const markdownInputPath = inputFileArg ? path.resolve(workDir, inputFileArg) : undefined;
  if (markdownInputPath) {
    const stat = await fs.stat(markdownInputPath);
    if (!stat.isFile()) throw new Error(`input is not a file: ${markdownInputPath}`);
  }

  const inputCwd = path.resolve(workDir, inputCwdArg ?? path.dirname(markdownInputPath!));
  const inputStat = await fs.stat(inputCwd);
  if (!inputStat.isDirectory()) throw new Error(`input_cwd is not a directory: ${inputCwd}`);

  const inputIdentity = markdownInputPath ?? inputCwd;
  const outputDir = path.join(workDir, "output");
  const specifiedRunDir = runDirArg ? path.resolve(workDir, runDirArg) : undefined;

  let runDir: string;
  let preCompleted: StageId[] | undefined;

  if (fork) {
    const sourceRunDir = specifiedRunDir ?? await findLatestRun(inputIdentity, outputDir);
    if (!sourceRunDir) {
      console.log("[main] No previous run found for --fork.");
      process.exit(1);
    }
    const ctx: UncertaintyContext = JSON.parse(await fs.readFile(path.join(sourceRunDir, "context.json"), "utf-8"));
    const completed = collectCompletedStages(ctx, workflow).length;
    const forkId = `${generateRunId(inputIdentity)}_fork-${completed}of${stageCount}`;
    runDir = path.join(outputDir, forkId);
    await fs.cp(sourceRunDir, runDir, { recursive: true });
    console.log(`[main] fork: ${path.basename(sourceRunDir)} → ${forkId}`);

    if (resume) {
      preCompleted = collectCompletedStages(ctx, workflow);
      console.log(`[main] fork resume from: ${runDir}`);
      console.log(`[main] already done: ${preCompleted.join(", ")} (${preCompleted.length}/${stageCount})`);
    } else if (startFrom !== undefined) {
      preCompleted = collectCompletedPrefix(ctx, workflow, startFrom.index);
      const clearEnd = endAt?.index ?? stageCount;
      clearStageRange(ctx, workflow, startFrom.index, clearEnd);
      await fs.writeFile(path.join(runDir, "context.json"), JSON.stringify(ctx, null, 2));
      console.log(`[main] fork startFrom ${startFrom.display} → ${runDir}`);
      console.log(`[main] keeping: ${preCompleted.join(", ") || "(none)"} (${preCompleted.length}/${stageCount}), reset ${stageRangeDisplay(workflow, startFrom.index, clearEnd)}`);
    }
  } else if (startFrom !== undefined) {
    const latest = specifiedRunDir ?? await findLatestRun(inputIdentity, outputDir);
    if (!latest) {
      console.log("[main] No previous run found for --startFrom.");
      process.exit(1);
    }
    runDir = latest;
    const ctx: UncertaintyContext = JSON.parse(await fs.readFile(path.join(runDir, "context.json"), "utf-8"));
    preCompleted = collectCompletedPrefix(ctx, workflow, startFrom.index);
    const clearEnd = endAt?.index ?? stageCount;
    clearStageRange(ctx, workflow, startFrom.index, clearEnd);
    await fs.writeFile(path.join(runDir, "context.json"), JSON.stringify(ctx, null, 2));
    console.log(`[main] startFrom ${startFrom.display} → ${runDir}`);
    console.log(`[main] keeping: ${preCompleted.join(", ") || "(none)"} (${preCompleted.length}/${stageCount}), reset ${stageRangeDisplay(workflow, startFrom.index, clearEnd)}`);
  } else if (resume) {
    if (specifiedRunDir) {
      runDir = specifiedRunDir;
      const ctx: UncertaintyContext = JSON.parse(await fs.readFile(path.join(runDir, "context.json"), "utf-8"));
      preCompleted = collectCompletedStages(ctx, workflow);
    } else {
      const result = await findLatestIncompleteRun(inputIdentity, outputDir, workflow);
      if (!result) {
        console.log("[main] No incomplete run found — pipeline is complete or no previous runs exist.");
        process.exit(0);
      }
      runDir = result.runDir;
      preCompleted = result.completedStages;
    }
    console.log(`[main] resume from: ${runDir}`);
    console.log(`[main] already done: ${preCompleted.join(", ")} (${preCompleted.length}/${stageCount})`);
  } else {
    const runId = generateRunId(inputIdentity);
    runDir = path.join(outputDir, runId);
    console.log(`[main] run:    ${runId}`);
    console.log(`[main] output: ${runDir}`);
  }

  if (forkOnly) {
    console.log(`[main] fork-only complete: ${runDir}`);
    console.log("[main] no pipeline run started");
    return;
  }

  const { model, apiKeyEnvVar } = await resolveModel(modelOverride);
  const apiKey = resolveConfiguredApiKey(apiKeyEnvVar);
  if (!apiKey) throw new Error(`API key not set: ${apiKeyEnvVar}`);

  console.log(`[main] model: ${model.provider}/${model.id}`);
  console.log(`[main] input_cwd: ${inputCwd}`);
  if (markdownInputPath) console.log(`[main] markdown: ${markdownInputPath}`);
  console.log(`[main] reference: ${referenceQueryUrl}`);

  const ctx = await runPipeline(
    workDir,
    inputCwd,
    runDir,
    model,
    apiKey,
    workflow,
    preCompleted,
    extraPromptArg,
    endAt?.index,
    referenceQueryUrl,
    markdownInputPath,
  );
  console.log("[main] pipeline finished");
  console.log("[main] completed stages:", ctx.completedStages.join(", "));
}

main().catch((e) => {
  console.error("[main] fatal error:", e);
  process.exit(1);
});
