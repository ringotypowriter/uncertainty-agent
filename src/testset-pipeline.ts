import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runPipeline } from "./pipeline.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import type { UncertaintyContext } from "./stages.js";
import { resolveConfiguredApiKey } from "./config/pi-config.js";

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

interface TestCase {
  id: string;
  dir: string;
  procedurePath: string;
  requirementsPath: string;
}

interface TestsetArgs {
  root: string;
  caseId?: string;
  fromCaseId?: string;
  toCaseId?: string;
  outputDir: string;
  model?: string;
  reviewModel?: string;
  referenceUrl: string;
  workers: number;
  resume: boolean;
  rerunReview: boolean;
  review: boolean;
  endAt: number;
}

export function parseTestsetArgs(argv: string[]): TestsetArgs {
  const root = argv.find((a) => a.startsWith("--root="))?.slice(7) ?? "input/atomic-steps-testset-input";
  const caseId = argv.find((a) => a.startsWith("--case="))?.slice(7);
  const fromCaseId = argv.find((a) => a.startsWith("--from="))?.slice(7);
  const toCaseId = argv.find((a) => a.startsWith("--to="))?.slice(5);
  const outputDir = argv.find((a) => a.startsWith("--output="))?.slice(9) ?? "output/testset";
  const model = argv.find((a) => a.startsWith("--model="))?.slice(8);
  const reviewModel = argv.find((a) => a.startsWith("--review-model="))?.slice(15);
  const referenceUrl = argv.find((a) => a.startsWith("--reference-url="))?.slice(16)
    ?? process.env.REFERENCE_QUERY_URL
    ?? process.env.STANDARDRAG_QUERY_TREE_URL
    ?? "http://127.0.0.1:8000/query-tree";
  const workersArg = argv.find((a) => a.startsWith("--workers="))?.slice(10)
    ?? argv.find((a) => a.startsWith("--concurrency="))?.slice(14);
  const workers = workersArg === undefined ? 4 : Math.max(1, Math.floor(Number(workersArg)));
  if (!Number.isFinite(workers)) throw new Error(`Invalid workers: ${workersArg}`);
  const resume = argv.includes("--resume") || argv.includes("--skip-done");
  const rerunReview = argv.includes("--rerun-review") || argv.includes("--force-review");
  const review = !(argv.includes("--no-review") || argv.includes("--pipeline-only"));

  // Pipeline has 4 stages: stage-123, stage-4, stage-5, stage-6.
  // Default to stopping before stage-6; stage-6 is presentation-only and should not affect evaluation.
  const endAtArg = argv.find((a) => a.startsWith("--end-at="))?.slice(9);
  const withStage6 = argv.includes("--with-stage6") || argv.includes("--stage6");
  const endAt = endAtArg !== undefined ? Math.max(1, Math.floor(Number(endAtArg))) : (withStage6 ? 4 : 3);
  if (endAtArg !== undefined && !Number.isFinite(Number(endAtArg))) throw new Error(`Invalid endAt: ${endAtArg}`);

  if (caseId && (fromCaseId || toCaseId)) throw new Error("Use either --case=... or --from/--to, not both");
  return { root, caseId, fromCaseId, toCaseId, outputDir, model, reviewModel, referenceUrl, workers, resume, rerunReview, review, endAt };
}

export async function discoverTestCases(workDir: string, root: string, onlyCaseId?: string, range?: { from?: string; to?: string }): Promise<TestCase[]> {
  const absRoot = path.resolve(workDir, root);
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  const cases: TestCase[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (onlyCaseId && entry.name !== onlyCaseId) continue;
    const dir = path.join(absRoot, entry.name);
    const procedurePath = path.join(dir, "procedure.md");
    const requirementsPath = path.join(dir, "requirements.txt");
    try {
      const [procedureStat, requirementsStat] = await Promise.all([
        fs.stat(procedurePath),
        fs.stat(requirementsPath),
      ]);
      if (procedureStat.isFile() && requirementsStat.isFile()) {
        cases.push({ id: entry.name, dir, procedurePath, requirementsPath });
      }
    } catch {
      // Ignore non-case folders.
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));

  if (range?.from || range?.to) {
    const from = range?.from;
    const to = range?.to;
    const filtered = cases.filter((c) => (!from || c.id.localeCompare(from) >= 0) && (!to || c.id.localeCompare(to) <= 0));
    if (filtered.length === 0) throw new Error(`No test cases found in range: ${from ?? "(start)"}..${to ?? "(end)"}`);
    return filtered;
  }

  if (onlyCaseId && cases.length === 0) throw new Error(`Test case not found: ${onlyCaseId}`);
  return cases;
}

async function resolveModel(modelOverride?: string): Promise<{ model: Model<any>; apiKeyEnvVar: string }> {
  const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const raw = await fs.readFile(modelsPath, "utf-8");
  const config = JSON.parse(raw);
  const providers = Object.keys(config.providers);

  let providerName: string;
  let modelId: string;
  if (modelOverride) {
    const sep = modelOverride.includes("/") ? "/" : ":";
    [providerName, modelId] = modelOverride.split(sep);
  } else {
    providerName = providers.find((p) => p !== "dashscope") ?? providers[0];
    modelId = config.providers[providerName].models[0]?.id;
  }
  if (!providerName || !modelId) throw new Error(`Invalid model: ${modelOverride ?? "(default)"}`);

  const provider = config.providers[providerName];
  if (!provider) throw new Error(`Provider "${providerName}" not found in ${modelsPath}`);
  const mc = provider.models.find((m: PiModelEntry) => m.id === modelId);
  if (!mc) throw new Error(`Model "${modelId}" not found in provider "${providerName}"`);

  return {
    model: {
      id: mc.id,
      name: mc.name,
      api: mc.api as any,
      provider: providerName,
      baseUrl: provider.baseUrl,
      reasoning: mc.reasoning,
      input: mc.input as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: mc.contextWindow,
      maxTokens: mc.maxTokens,
      compat: mc.compat as any,
    },
    apiKeyEnvVar: provider.apiKey,
  };
}

function generateCaseRunId(caseId: string): string {
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "").replace("T", "_");
  return `${caseId}_${ts}`;
}

async function findLatestRunDir(outputRoot: string, caseId: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(outputRoot, { withFileTypes: true });
    const prefix = `${caseId}_`;
    const runNames = entries.filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => e.name).sort();
    const latest = runNames[runNames.length - 1];
    return latest ? path.join(outputRoot, latest) : undefined;
  } catch {
    return undefined;
  }
}

function isContextComplete(ctx: any): boolean {
  return Boolean(
    ctx?.stage1_measurand &&
    ctx?.stage2_measurement_model &&
    ctx?.stage3_uncertainty_sources &&
    ctx?.stage4_quantification &&
    ctx?.stage5_synthesis_expanded
  );
}

function inferCompletedStages(ctx: any): string[] {
  const done: string[] = [];
  if (ctx?.stage1_measurand && ctx?.stage2_measurement_model && ctx?.stage3_uncertainty_sources) done.push("stage-123");
  if (ctx?.stage4_quantification) done.push("stage-4");
  if (ctx?.stage5_synthesis_expanded) done.push("stage-5");
  if (ctx?.stage6_report_artifacts) done.push("stage-6");
  return done;
}

type ResumePlan =
  | { action: "skip" }
  | { action: "review"; runDir: string }
  | { action: "resume"; runDir: string; preCompleted: string[] }
  | { action: "full" };

async function planResume(outputRoot: string, caseId: string, opts?: { rerunReview?: boolean }): Promise<ResumePlan> {
  const latestDir = await findLatestRunDir(outputRoot, caseId);
  if (!latestDir) return { action: "full" };

  const evalPath = path.join(latestDir, "requirements_evaluation.md");
  try {
    const st = await fs.stat(evalPath);
    if (st.isFile() && !opts?.rerunReview) return { action: "skip" };
  } catch {
    // continue
  }

  const ctxPath = path.join(latestDir, "context.json");
  try {
    const raw = await fs.readFile(ctxPath, "utf-8");
    const ctx = JSON.parse(raw);
    if (isContextComplete(ctx)) return { action: "review", runDir: latestDir };
    const preCompleted = inferCompletedStages(ctx);
    if (preCompleted.length > 0) return { action: "resume", runDir: latestDir, preCompleted };
  } catch {
    // continue
  }

  return { action: "full" };
}

function parseSummary(text: string): { total: number; completed: number } | undefined {
  const match = /SUMMARY\s+total=(\d+)\s+completed=(\d+)/i.exec(text);
  if (!match) return undefined;
  return { total: Number(match[1]), completed: Number(match[2]) };
}

async function runRequirementsEvaluation(
  testCase: TestCase,
  runDir: string,
  ctx: UncertaintyContext,
  model: Model<any>,
  apiKey: string,
  opts?: { quiet?: boolean },
): Promise<{ report: string; total?: number; completed?: number }> {
  const requirements = await fs.readFile(testCase.requirementsPath, "utf-8");
  const inputMaterial = await fs.readFile(testCase.procedurePath, "utf-8");
  const contextForEval = {
    stage1_measurand: ctx.stage1_measurand,
    stage2_measurement_model: ctx.stage2_measurement_model,
    stage3_uncertainty_sources: ctx.stage3_uncertainty_sources,
    stage4_quantification: ctx.stage4_quantification,
    stage5_synthesis_expanded: ctx.stage5_synthesis_expanded,
  };
  const contextJson = JSON.stringify(contextForEval, null, 2);
  const prompt = `请对每个 requirements 条件逐项评分并汇报总数和完成数。

## requirements.txt

${requirements}

## procedure.md

${inputMaterial}

## context.json (trimmed to stages 1-5)

\`\`\`json
${contextJson}
\`\`\``;

  const agent = new Agent({
    initialState: {
      systemPrompt: `你是独立的测试集评审 agent，使用 requirements.txt 评估 uncertainty-agent 产出的 context.json。\n\n将 requirements.txt 中的评定要求拆成可判断的条件，逐项判断 context 是否完成。标准答案 JSON 只用于数值对照和容差信息，不作为 context 输出格式要求。\n\n输出以 SUMMARY total=N completed=M 开头。随后输出中文 Markdown 表格：条件编号、条件、判断（✅完成/❌未完成/⚠️部分完成）、证据、说明。最后给出简短结论。`,
      model,
      thinkingLevel: "medium",
      tools: [],
    },
    getApiKey: () => apiKey,
  });

  const quiet = opts?.quiet ?? false;
  let output = "";
  agent.subscribe((event: any) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae?.type === "text_delta" && ae.delta) {
        output += ae.delta;
        if (!quiet) process.stdout.write(ae.delta);
      }
    } else if (event.type === "message_end" && event.message?.role === "assistant" && !output) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            output += block.text;
            if (!quiet) process.stdout.write(block.text);
          }
        }
      }
    }
  });

  if (!quiet) console.log(`\n--- requirements evaluation: ${testCase.id} ---`);
  await agent.prompt(prompt);
  if (!quiet) process.stdout.write("\n");
  const summary = parseSummary(output);
  const reportPath = path.join(runDir, "requirements_evaluation.md");
  await fs.writeFile(reportPath, output || "(evaluation agent produced no output)", "utf-8");
  return { report: output, total: summary?.total, completed: summary?.completed };
}

interface TestsetResult {
  caseId: string;
  status: "complete" | "failed";
  completed?: number;
  total?: number;
  runDir: string;
}

type PlannedTestCase = { testCase: TestCase; plan: ResumePlan; };

async function readExistingEvaluation(runDir: string): Promise<{ total?: number; completed?: number } | undefined> {
  try {
    const text = await fs.readFile(path.join(runDir, "requirements_evaluation.md"), "utf-8");
    return parseSummary(text);
  } catch {
    return undefined;
  }
}

async function runReviewOnly(
  testCase: TestCase,
  runDir: string,
  model: Model<any>,
  apiKey: string,
  opts?: { quiet?: boolean; onProgress?: (event: { type: "start" | "done"; caseId: string; status?: "complete" | "failed"; completed?: number; total?: number }) => void },
): Promise<TestsetResult> {
  const quiet = opts?.quiet ?? false;
  opts?.onProgress?.({ type: "start", caseId: testCase.id });
  try {
    const raw = await fs.readFile(path.join(runDir, "context.json"), "utf-8");
    const ctx: UncertaintyContext = JSON.parse(raw);
    const evaluation = await runRequirementsEvaluation(testCase, runDir, ctx, model, apiKey, { quiet });
    opts?.onProgress?.({ type: "done", caseId: testCase.id, status: "complete", completed: evaluation.completed, total: evaluation.total });
    return { caseId: testCase.id, status: "complete", completed: evaluation.completed, total: evaluation.total, runDir };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (!quiet) console.error(`[testset] ${testCase.id} review failed: ${msg}`);
    opts?.onProgress?.({ type: "done", caseId: testCase.id, status: "failed" });
    return { caseId: testCase.id, status: "failed", runDir };
  }
}

async function runTestCase(
  workDir: string,
  outputRoot: string,
  testCase: TestCase,
  model: Model<any>,
  apiKey: string,
  workflow: Awaited<ReturnType<typeof loadWorkflowConfig>>,
  referenceUrl: string,
  opts?: { quiet?: boolean; onProgress?: (event: { type: "start" | "done"; caseId: string; status?: "complete" | "failed"; completed?: number; total?: number }) => void; resumeInDir?: { runDir: string; preCompleted: string[] }; review?: boolean; endAt?: number; reviewModel?: Model<any>; reviewApiKey?: string },
): Promise<TestsetResult> {
  const quiet = opts?.quiet ?? false;
  const review = opts?.review ?? true;
  const resumeInDir = opts?.resumeInDir;
  const runDir = resumeInDir?.runDir ?? path.join(outputRoot, generateCaseRunId(testCase.id));
  if (!quiet) console.log(`\n[testset] ${testCase.id} → ${runDir}`);
  opts?.onProgress?.({ type: "start", caseId: testCase.id });
  try {
    const pipelineContext = await runPipeline(
      workDir,
      testCase.dir,
      runDir,
      model,
      apiKey,
      workflow,
      resumeInDir?.preCompleted,
      undefined,
      opts?.endAt,
      referenceUrl,
      testCase.procedurePath,
      { quiet },
    );
    const ctxRaw = await fs.readFile(pipelineContext.contextPath, "utf-8");
    const ctx: UncertaintyContext = JSON.parse(ctxRaw);
    if (!review) {
      opts?.onProgress?.({ type: "done", caseId: testCase.id, status: "complete" });
      return { caseId: testCase.id, status: "complete" as const, runDir };
    }
    if (!quiet) console.log(`\n[testset] ${testCase.id} requirements evaluation`);
    const evaluation = await runRequirementsEvaluation(testCase, runDir, ctx, opts?.reviewModel ?? model, opts?.reviewApiKey ?? apiKey, { quiet });
    opts?.onProgress?.({ type: "done", caseId: testCase.id, status: "complete", completed: evaluation.completed, total: evaluation.total });
    return { caseId: testCase.id, status: "complete", completed: evaluation.completed, total: evaluation.total, runDir };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "failure.txt"), msg, "utf-8");
    if (!quiet) console.error(`[testset] ${testCase.id} failed: ${msg}`);
    opts?.onProgress?.({ type: "done", caseId: testCase.id, status: "failed" });
    return { caseId: testCase.id, status: "failed", runDir };
  }
}

async function runConcurrent<T, R>(items: T[], workerCount: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(workerCount, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseTestsetArgs(process.argv.slice(2));
  const workDir = process.cwd();
  const workflow = await loadWorkflowConfig(workDir);
  let cases = await discoverTestCases(workDir, args.root, args.caseId, { from: args.fromCaseId, to: args.toCaseId });
  const { model, apiKeyEnvVar } = await resolveModel(args.model);
  const apiKey = resolveConfiguredApiKey(apiKeyEnvVar);
  if (!apiKey) throw new Error(`API key not set: ${apiKeyEnvVar}`);
  const { model: reviewModel, apiKeyEnvVar: reviewApiKeyEnvVar } = args.reviewModel ? await resolveModel(args.reviewModel) : { model, apiKeyEnvVar };
  const reviewApiKey = resolveConfiguredApiKey(reviewApiKeyEnvVar);
  if (args.review && !reviewApiKey) throw new Error(`Review API key not set: ${reviewApiKeyEnvVar}`);

  const outputRoot = path.resolve(workDir, args.outputDir);
  await fs.mkdir(outputRoot, { recursive: true });

  const planned: PlannedTestCase[] = [];
  for (const testCase of cases) {
    const plan = args.resume ? await planResume(outputRoot, testCase.id, { rerunReview: args.rerunReview }) : { action: "full" } as ResumePlan;
    if (plan.action === "skip") continue;
    planned.push({ testCase, plan });
  }

  if (planned.length === 0) {
    console.log("[testset] no cases to run");
    return;
  }

  const workerCount = Math.min(args.workers, Math.max(1, planned.length));

  console.log(`[testset] cases: ${planned.length}/${cases.length} scheduled`);
  console.log(`[testset] workers: ${workerCount}`);
  console.log(`[testset] model: ${model.provider}/${model.id}`);
  console.log(`[testset] review model: ${reviewModel.provider}/${reviewModel.id}`);
  console.log(`[testset] reference: ${args.referenceUrl}`);

  const quiet = workerCount > 1;
  let started = 0;
  let finished = 0;
  const total = planned.length;
  const onProgress = (event: { type: "start" | "done"; caseId: string; status?: "complete" | "failed"; completed?: number; total?: number }) => {
    if (!quiet) return;
    if (event.type === "start") {
      started++;
      console.log(`[testset] ${started}/${total} start ${event.caseId}`);
    } else {
      finished++;
      const score = event.status === "complete" ? ` ${event.completed ?? "?"}/${event.total ?? "?"}` : "";
      console.log(`[testset] ${finished}/${total} done  ${event.caseId} ${event.status}${score}`);
    }
  };

  const results = await runConcurrent(planned, workerCount, async (item) => {
    const testCase = item.testCase;
    const plan = item.plan;
    if (plan.action === "review") {
      if (!args.review) return { caseId: testCase.id, status: "complete" as const, runDir: plan.runDir };
      return runReviewOnly(testCase, plan.runDir, reviewModel, reviewApiKey!, { quiet, onProgress });
    }
    if (plan.action === "resume") {
      return runTestCase(
        workDir,
        outputRoot,
        testCase,
        model,
        apiKey,
        workflow,
        args.referenceUrl,
        { quiet, onProgress, resumeInDir: { runDir: plan.runDir, preCompleted: plan.preCompleted }, review: args.review, endAt: args.endAt, reviewModel, reviewApiKey },
      );
    }
    // full
    return runTestCase(
      workDir,
      outputRoot,
      testCase,
      model,
      apiKey,
      workflow,
      args.referenceUrl,
      { quiet, onProgress, review: args.review, endAt: args.endAt, reviewModel, reviewApiKey },
    );
  });

  const summaryRows = results.map((result) => {
    if (result.status === "complete") {
      return `| ${result.caseId} | ✅ pipeline complete | ${result.completed ?? "?"}/${result.total ?? "?"} | ${path.relative(workDir, result.runDir)} |`;
    }
    return `| ${result.caseId} | ❌ failed | - | ${path.relative(workDir, result.runDir)} |`;
  });

  const summary = [
    "# Atomic steps testset summary",
    "",
    `Model: ${model.provider}/${model.id}`,
    `Review model: ${reviewModel.provider}/${reviewModel.id}`,
    `Cases: ${cases.length}`,
    `Workers: ${workerCount}`,
    "",
    "| Case | Status | Requirements completed | Run dir |",
    "|---|---|---:|---|",
    ...summaryRows,
    "",
  ].join("\n");
  const summaryPath = path.join(outputRoot, "summary.md");
  await fs.writeFile(summaryPath, summary, "utf-8");
  console.log(`\n[testset] summary → ${summaryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("[testset] fatal:", e); process.exit(1); });
}

