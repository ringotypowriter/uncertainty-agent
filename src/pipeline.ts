import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, type WriteStream } from "node:fs";
import chalk from "chalk";
import type { StageConfig, StageId, PipelineContext } from "./stages.js";
import { ContextManager } from "./context-manager.js";
import {
  makeFinishWorkTool,
  makeSearchReferenceTool,
  makeCalculateTool,
  runReferenceSearch,
  type FinishWorkState,
} from "./tools/general-tools.js";
import {
  findFirstIncompleteWorkItemIndex,
  formatWorkItemPrompt,
  getStageContextFields,
  getStageOrder,
  getStageWorkItems,
} from "./workflow-config.js";
import type { WorkflowConfig, WorkflowStage, WorkflowWorkItem } from "./workflow-config.js";

const MAX_RETRIES = 3;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TURNS = 100;
const LOOP_DETECT_WINDOW = 3;

class PipelineLogger {
  private stream: WriteStream;
  private consoleEnabled: boolean;
  constructor(logPath: string, opts?: { consoleEnabled?: boolean }) {
    this.stream = createWriteStream(logPath, { flags: "a" });
    this.consoleEnabled = opts?.consoleEnabled ?? true;
  }
  log(msg: string, consoleMsg?: string, fileMsg?: string) {
    const ts = new Date().toISOString().slice(11, 19);
    const fileLine = `[${ts}] ${fileMsg ?? msg}`;
    if (this.consoleEnabled) console.log(`[${ts}] ${consoleMsg ?? msg}`);
    this.stream.write(fileLine + "\n");
  }
  appendFile(text: string) { this.stream.write(text); }
  close() { this.stream.end(); }
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        result.push(abs);
      }
    }
  }
  await walk(root);
  return result.sort();
}

async function buildMarkdownContext(context: PipelineContext): Promise<string> {
  const files = context.markdownInputPath
    ? [path.resolve(context.workDir, context.markdownInputPath)]
    : await collectMarkdownFiles(context.inputCwd);

  if (files.length === 0) return "未找到 Markdown 输入。";

  const blocks: string[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const rel = path.relative(context.inputCwd, file).split(path.sep).join("/") || path.basename(file);
    blocks.push([`### ${rel}`, "", "```markdown", content.trimEnd(), "```"].join("\n"));
  }
  return blocks.join("\n\n");
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

async function stageHasCompleteOutputs(stage: WorkflowStage, contextManager: ContextManager): Promise<boolean> {
  await contextManager.load();
  const ctx = contextManager.getAll() as Record<string, unknown>;
  return getStageContextFields(stage).every((field) => !isMissing(ctx[field]));
}

function formatJsonBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

async function formatSchemaBlock(context: PipelineContext, workItem: WorkflowWorkItem): Promise<string> {
  const schemaPath = path.resolve(context.workDir, workItem.schemaPath);
  const schemaText = await fs.readFile(schemaPath, "utf-8");
  return ["## JSON Schema", "", "```json", schemaText.trim(), "```"].join("\n");
}

async function formatWorkItemPromptWithSchema(context: PipelineContext, workItem: WorkflowWorkItem): Promise<string> {
  return [formatWorkItemPrompt(workItem), "", await formatSchemaBlock(context, workItem)].join("\n");
}

async function formatReferenceQueriesBlock(
  context: PipelineContext,
  workItem: WorkflowWorkItem,
  logger: PipelineLogger,
): Promise<string | undefined> {
  if (!workItem.referenceQueries?.length) return undefined;

  const blocks: string[] = [];
  for (const query of workItem.referenceQueries) {
    const limit = query.limit ?? 8;
    logger.log(
      `${context.currentStage ?? "pipeline"} reference query ${query.id}: ${query.query}`,
      `${chalk.bold(context.currentStage ?? "pipeline")} 🔎 reference ${chalk.cyan(query.id)}`,
    );
    try {
      const result = await runReferenceSearch(context.referenceQueryUrl, { query: query.query, limit });
      blocks.push([
        `### ${query.id}`,
        `query: ${query.query}`,
        `top_k: ${limit}`,
        formatJsonBlock(result),
      ].join("\n\n"));
    } catch (e: any) {
      throw new Error(`reference query failed (${query.id}): ${e.message ?? e}`);
    }
  }

  return ["## 检索依据", ...blocks].join("\n\n");
}

async function buildInitialPrompt(
  config: StageConfig,
  context: PipelineContext,
  contextManager: ContextManager,
  state: FinishWorkState,
  logger: PipelineLogger,
  extraPrompt?: string,
): Promise<string> {
  const stage = config.workflowStage;
  const workItems = getStageWorkItems(stage);
  const current = workItems[state.currentIndex];
  const parts: string[] = stage.checkpoints?.length ? [stage.prompt.trim()] : [];

  await contextManager.load();
  const ctx = contextManager.getAll() as Record<string, unknown>;

  if (stage.paperContext) {
    parts.push("---", "## 输入材料 Markdown", await buildMarkdownContext(context));
  }

  if (stage.inputContextField) {
    const inputValue = ctx[stage.inputContextField];
    if (isMissing(inputValue)) {
      throw new Error(`${config.id} requires context field ${stage.inputContextField}`);
    }
    parts.push("---", "## 输入产物", formatJsonBlock(inputValue));
  }

  const completedItems = workItems.slice(0, state.currentIndex);
  if (completedItems.length > 0) {
    const completed = completedItems.map((item) => [
      `### ${item.title}`,
      formatJsonBlock(ctx[item.contextField]),
    ].join("\n")).join("\n\n");
    parts.push("---", "## 已完成 checkpoint 产物", completed);
  }

  if (current) {
    const referenceBlock = await formatReferenceQueriesBlock(context, current, logger);
    if (referenceBlock) parts.push("---", referenceBlock);
    parts.push("---", await formatWorkItemPromptWithSchema(context, current));
  }

  if (extraPrompt) {
    parts.push("---", "## Additional instruction", extraPrompt);
  }

  return parts.join("\n\n");
}

function buildToolSet(
  config: StageConfig,
  contextManager: ContextManager,
  pipelineContext: PipelineContext,
  finishState: FinishWorkState,
) {
  return [
    makeFinishWorkTool(contextManager, pipelineContext, config.workflowStage, finishState),
    makeSearchReferenceTool(pipelineContext.referenceQueryUrl),
    makeCalculateTool(),
  ];
}

async function runStageOnce(
  config: StageConfig,
  context: PipelineContext,
  defaultModel: Model<any>,
  apiKey: string,
  contextManager: ContextManager,
  logger: PipelineLogger,
  extraPrompt?: string,
  opts?: { quiet?: boolean },
): Promise<boolean> {
  const quiet = opts?.quiet ?? false;
  logger.log(`starting ${config.id}: ${config.name}`, `${chalk.bold(config.id)}: ${config.name}`);
  context.currentStage = config.id;

  await contextManager.load();
  const firstIncomplete = findFirstIncompleteWorkItemIndex(config.workflowStage, contextManager.getAll() as Record<string, unknown>);
  const workItems = getStageWorkItems(config.workflowStage);
  if (firstIncomplete >= workItems.length) {
    if (!context.completedStages.includes(config.id)) context.completedStages.push(config.id);
    context.currentStage = null;
    return true;
  }

  const finishState: FinishWorkState = { currentIndex: firstIncomplete, completed: false, writtenFields: [] };
  const tools = buildToolSet(config, contextManager, context, finishState);

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt ?? `You are a measurement uncertainty expert. Execute: ${config.name}.`,
      model: config.model ?? defaultModel,
      thinkingLevel: "medium",
      tools,
    },
    getApiKey: () => apiKey,
    ...config.agentOptions,
  });

  const promptText = await buildInitialPrompt(config, context, contextManager, finishState, logger, extraPrompt);

  const startedAt = Date.now();
  const chunks: string[] = [];
  let totalTokens = 0, inputTokens = 0, outputTokens = 0;
  let turnCount = 0;
  let killedBy = "";
  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);
  let inToolExecution = false;
  let modelTextDangling = false;
  let loopLastCall = "";
  let loopStreak = 0;
  const stageTag = `[${config.id}]`;
  if (!quiet) process.stdout.write(chalk.bold(`\n${stageTag} ──────────────────────\n`));

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    if (!inToolExecution) {
      idleTimer = setTimeout(() => {
        killedBy = "idle_timeout";
        agent.abort();
      }, IDLE_TIMEOUT_MS);
    }
  };
  resetIdleTimer();

  agent.subscribe((event) => {
    resetIdleTimer();
    if (event.type === "tool_execution_start") {
      inToolExecution = true;
      clearTimeout(idleTimer);
      const callSig = event.toolName + "|" + JSON.stringify(event.args);
      if (callSig === loopLastCall) {
        loopStreak++;
        if (loopStreak >= LOOP_DETECT_WINDOW) {
          killedBy = "loop_detected";
          logger.log(`${config.id} LOOP: ${event.toolName} called ${loopStreak}x with same args — aborting`, `${chalk.bold(config.id)} ${chalk.red.bold("LOOP")}: ${chalk.cyan(event.toolName)} called ${loopStreak}x with same args — aborting`);
          agent.abort();
        }
      } else {
        loopLastCall = callSig;
        loopStreak = 1;
      }
      if (event.toolName === "finishWork") {
        loopLastCall = "";
        loopStreak = 0;
      }
      if (modelTextDangling) {
        if (!quiet) process.stdout.write("\n");
        logger.appendFile("\n");
        modelTextDangling = false;
      }
      const argsStr = JSON.stringify(event.args);
      const briefArgs = argsStr.length > 120 ? argsStr.slice(0, 120) + "…" : argsStr;
      logger.log(`${config.id} 🔧 ${event.toolName}(${briefArgs})`, `${chalk.bold(config.id)} 🔧 ${chalk.cyan(event.toolName)}(${chalk.dim(briefArgs)})`);
    }
    if (event.type === "tool_execution_end") {
      inToolExecution = false;
      resetIdleTimer();
      const icon = event.isError ? "❌" : "✅";
      const contentArr = (event.result as any)?.content as any[] | undefined;
      let resultBrief = "";
      let resultFull = "";
      if (Array.isArray(contentArr) && contentArr.length > 0) {
        const first = contentArr[0];
        if (first && typeof first.text === "string") {
          const text = first.text.replace(/\n/g, " ");
          resultBrief = text.slice(0, 150);
          resultFull = text;
        }
      }
      const tail = resultBrief ? ` → ${resultBrief}` : "";
      const fullTail = resultFull ? ` → ${resultFull}` : "";
      logger.log(
        `${config.id} ${icon} ${event.toolName}${tail}`,
        `${chalk.bold(config.id)} ${icon} ${chalk.cyan(event.toolName)}${chalk.dim(tail)}`,
        `${config.id} ${icon} ${event.toolName}${fullTail}`,
      );
    }
    if (event.type === "turn_start") {
      turnCount++;
      if (turnCount > MAX_TURNS) {
        killedBy = "max_turns";
        agent.abort();
      }
    }
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (!ae) return;
      if (ae.type === "text_delta" && ae.delta) {
        chunks.push(ae.delta);
        if (!quiet) process.stdout.write(chalk.gray(ae.delta));
        logger.appendFile(ae.delta);
        modelTextDangling = true;
      }
      if (ae.type === "thinking_delta" && ae.delta) {
        chunks.push(ae.delta);
        if (!quiet) process.stdout.write(chalk.dim(ae.delta));
        logger.appendFile(ae.delta);
        modelTextDangling = true;
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const usage = (event.message as any).usage;
      if (usage) {
        totalTokens = usage.totalTokens ?? 0;
        inputTokens = usage.input ?? 0;
        outputTokens = usage.output ?? 0;
      }
      if (chunks.length === 0) {
        const content = (event.message as any).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && block.text) chunks.push(block.text);
          }
        }
      }
    }
  });

  await agent.prompt(promptText);

  while (!killedBy && !agent.state.errorMessage && !(finishState.completed || await stageHasCompleteOutputs(config.workflowStage, contextManager)) && turnCount < MAX_TURNS) {
    logger.log(`${config.id} WARN: finishWork not called — continuing`, `${chalk.bold(config.id)} ${chalk.yellow("WARN")}: finishWork not called — continuing`);
    await agent.prompt("继续当前工作。只有调用 finishWork 并通过 JSON schema 校验后，当前 checkpoint 或 stage 才会结束。");
  }

  clearTimeout(idleTimer);
  if (!quiet) process.stdout.write("\n");
  logger.appendFile("\n");

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const rawOutput = chunks.join("");
  const fmtT = (n: number) => n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : String(n);
  const complete = finishState.completed || await stageHasCompleteOutputs(config.workflowStage, contextManager);
  const errorMsg = killedBy || agent.state.errorMessage || (!complete ? "finishWork was not accepted before the turn limit" : undefined);
  const success = !errorMsg;

  if (errorMsg) {
    logger.log(`${config.id} ${killedBy ? "KILLED" : "ERROR"}: ${errorMsg.slice(0, 300)}`, `${chalk.bold(config.id)} ${chalk.red.bold(killedBy ? "KILLED" : "ERROR")}: ${errorMsg.slice(0, 300)}`);
  }

  const statusText = success ? chalk.green("done") : chalk.red.bold("FAILED");
  const statsText = chalk.dim(`in ${elapsed}s | tokens: ${fmtT(totalTokens)} (in ${fmtT(inputTokens)} / out ${fmtT(outputTokens)}) | turns: ${turnCount} | output ${rawOutput.length}c`);
  logger.log(
    `${config.id} ${success ? "done" : "FAILED"} in ${elapsed}s | ` +
    `tokens: ${fmtT(totalTokens)} (in ${fmtT(inputTokens)} / out ${fmtT(outputTokens)}) | ` +
    `turns: ${turnCount} | output ${rawOutput.length}c`,
    `${chalk.bold(config.id)} ${statusText} ${statsText}`,
  );

  if (success && !context.completedStages.includes(config.id)) context.completedStages.push(config.id);
  context.currentStage = null;
  return success;
}

async function runStageWithRetry(
  config: StageConfig,
  context: PipelineContext,
  defaultModel: Model<any>,
  apiKey: string,
  contextManager: ContextManager,
  logger: PipelineLogger,
  extraPrompt?: string,
  opts?: { quiet?: boolean },
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ok = await runStageOnce(config, context, defaultModel, apiKey, contextManager, logger, extraPrompt, opts);
    if (ok) {
      if (attempt > 1) logger.log(`${config.id} succeeded on retry #${attempt}`, `${chalk.bold(config.id)} ${chalk.green("succeeded")} on retry #${attempt}`);
      return;
    }
    logger.log(`${config.id} attempt ${attempt}/${MAX_RETRIES} failed`, `${chalk.bold(config.id)} attempt ${attempt}/${MAX_RETRIES} ${chalk.yellow("failed")}`);
    if (attempt < MAX_RETRIES) {
      logger.log(`${config.id} retrying...`, `${chalk.bold(config.id)} ${chalk.yellow("retrying...")}`);
      context.completedStages = context.completedStages.filter((stageId) => stageId !== config.id);
    }
  }
  throw new Error(`${config.id} failed after ${MAX_RETRIES} attempts. Pipeline halted.`);
}

export async function runPipeline(
  workDir: string,
  inputCwd: string,
  runDir: string,
  defaultModel: Model<any>,
  apiKey: string,
  workflow: WorkflowConfig,
  preCompleted?: StageId[],
  extraPrompt?: string,
  endAt?: number,
  referenceQueryUrl = "http://127.0.0.1:8000/query-tree",
  markdownInputPath?: string,
  opts?: { quiet?: boolean },
): Promise<PipelineContext> {
  await fs.mkdir(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  const quiet = opts?.quiet ?? false;
  const logger = new PipelineLogger(logPath, { consoleEnabled: !quiet });

  const context: PipelineContext = {
    workDir,
    workflow,
    inputDir: inputCwd,
    inputCwd,
    outputDir: runDir,
    contextPath: path.join(runDir, "context.json"),
    feedbackPath: path.join(runDir, "feedback.json"),
    referenceQueryUrl,
    currentStage: null,
    completedStages: preCompleted ? [...preCompleted] : [],
    markdownInputPath,
  };

  const contextManager = new ContextManager(context.contextPath);
  const { createStageConfigs } = await import("./agents/stage-configs.js");
  const configs = createStageConfigs(workflow);
  const stageOrder = getStageOrder(workflow);

  const effectiveEnd = endAt ?? configs.length;
  const endStageId = stageOrder[effectiveEnd - 1] ?? `#${effectiveEnd}`;
  const rangeInfo = endAt ? `${stageOrder[0]}→${endStageId}` : `${configs.length} stages`;
  const stagesInRange = configs.slice(0, effectiveEnd);
  const completedInRange = preCompleted?.filter((stageId) => {
    const stageNum = stageOrder.indexOf(stageId) + 1;
    return stageNum > 0 && stageNum <= effectiveEnd;
  }) ?? [];
  const remainingInRange = Math.max(0, stagesInRange.length - completedInRange.length);
  const isResume = preCompleted && preCompleted.length > 0;
  logger.log(
    isResume
      ? `pipeline resume | ${completedInRange.length}/${stagesInRange.length} stages done in ${rangeInfo}, ${remainingInRange} remaining | input_cwd: ${inputCwd}`
      : `pipeline start | ${rangeInfo} | input_cwd: ${inputCwd}`,
    chalk.bold(isResume
      ? `pipeline resume | ${completedInRange.length}/${stagesInRange.length} done in ${rangeInfo} → ${remainingInRange} remaining`
      : `pipeline start | ${rangeInfo} | input_cwd: ${path.basename(inputCwd)}`),
  );

  try {
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      if (context.completedStages.includes(config.id)) continue;
      await runStageWithRetry(config, context, defaultModel, apiKey, contextManager, logger, extraPrompt, { quiet });

      if (endAt !== undefined && i + 1 >= endAt) {
        logger.log(`pipeline stopped at ${config.id} (endAt=${endStageId})`, chalk.bold(`pipeline stopped at ${config.id} (endAt=${endStageId})`));
        break;
      }
    }

    logger.log(`pipeline finished | ${context.completedStages.length}/${configs.length} stages`, chalk.bold(`pipeline finished | ${context.completedStages.length}/${configs.length} stages`));
  } finally {
    logger.close();
  }

  return context;
}
