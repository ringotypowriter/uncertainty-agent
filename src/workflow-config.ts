import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_WORKFLOW_CONFIG_PATH = "config/workflow.json";

export interface WorkflowReferenceQuery {
  id: string;
  query: string;
  mode?: "simple" | "relation";
  limit?: number;
}

export interface WorkflowWorkItem {
  id: string;
  title: string;
  contextField: string;
  schemaPath: string;
  prompt: string;
  referenceQueries?: WorkflowReferenceQuery[];
}

export interface WorkflowStage {
  id: string;
  title: string;
  /** System prompt for this SubAgent only. */
  systemPrompt?: string;
  /** Inject Markdown source material into the first user prompt. */
  paperContext?: boolean;
  /** Inject exactly one prior work product into the first user prompt. */
  inputContextField?: string;
  schemaPath?: string;
  contextField?: string;
  referenceQueries?: WorkflowReferenceQuery[];
  checkpoints?: WorkflowWorkItem[];
  prompt: string;
}

export interface WorkflowConfig {
  path: string;
  stages: WorkflowStage[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, label: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${field} must be a non-empty string when provided`);
  }
  return value;
}

function parsePrompt(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((line) => typeof line === "string")) {
    const prompt = value.join("\n");
    if (prompt.trim() !== "") return prompt;
  }
  throw new Error(`${label}.prompt must be a non-empty string or string array`);
}

function validateUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} must be unique: ${value}`);
    seen.add(value);
  }
}

function parseReferenceQueries(value: unknown, label: string): WorkflowReferenceQuery[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array when provided`);
  const parsed = value.map((item, index): WorkflowReferenceQuery => {
    const itemLabel = `${label}[${index}]`;
    const obj = asRecord(item, itemLabel);
    const mode = optionalString(obj, "mode", itemLabel);
    if (mode !== undefined && mode !== "simple" && mode !== "relation") {
      throw new Error(`${itemLabel}.mode must be simple or relation`);
    }
    const rawLimit = obj.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 30)) {
      throw new Error(`${itemLabel}.limit must be a number from 1 to 30`);
    }
    return {
      id: requireString(obj, "id", itemLabel),
      query: requireString(obj, "query", itemLabel),
      mode,
      limit: rawLimit as number | undefined,
    };
  });
  validateUnique(parsed.map((query) => query.id), `${label}[].id`);
  return parsed;
}

function parseWorkItem(item: unknown, label: string): WorkflowWorkItem {
  const obj = asRecord(item, label);
  return {
    id: requireString(obj, "id", label),
    title: requireString(obj, "title", label),
    contextField: requireString(obj, "contextField", label),
    schemaPath: requireString(obj, "schemaPath", label),
    prompt: parsePrompt(obj.prompt, label),
    referenceQueries: parseReferenceQueries(obj.referenceQueries, `${label}.referenceQueries`),
  };
}

export async function loadWorkflowConfig(
  workDir: string,
  configPath = DEFAULT_WORKFLOW_CONFIG_PATH,
): Promise<WorkflowConfig> {
  const absPath = path.resolve(workDir, configPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const root = asRecord(JSON.parse(raw), "workflow config");
  const rawStages = root.stages;
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    throw new Error("workflow config stages must be a non-empty array");
  }

  const stages = rawStages.map((item, index): WorkflowStage => {
    const label = `stages[${index}]`;
    const obj = asRecord(item, label);
    const rawCheckpoints = obj.checkpoints;
    const checkpoints = rawCheckpoints === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(rawCheckpoints) || rawCheckpoints.length === 0) {
            throw new Error(`${label}.checkpoints must be a non-empty array when provided`);
          }
          const parsed = rawCheckpoints.map((checkpoint, checkpointIndex) => parseWorkItem(checkpoint, `${label}.checkpoints[${checkpointIndex}]`));
          validateUnique(parsed.map((checkpoint) => checkpoint.id), `${label}.checkpoints[].id`);
          validateUnique(parsed.map((checkpoint) => checkpoint.contextField), `${label}.checkpoints[].contextField`);
          return parsed;
        })();

    const stage: WorkflowStage = {
      id: requireString(obj, "id", label),
      title: requireString(obj, "title", label),
      systemPrompt: optionalString(obj, "systemPrompt", label),
      paperContext: obj.paperContext === true,
      inputContextField: optionalString(obj, "inputContextField", label),
      prompt: parsePrompt(obj.prompt, label),
      referenceQueries: parseReferenceQueries(obj.referenceQueries, `${label}.referenceQueries`),
      checkpoints,
    };

    if (!checkpoints) {
      stage.contextField = requireString(obj, "contextField", label);
      stage.schemaPath = requireString(obj, "schemaPath", label);
    }

    return stage;
  });

  validateUnique(stages.map((stage) => stage.id), "stages[].id");
  validateUnique(stages.flatMap((stage) => getStageWorkItems(stage).map((item) => item.contextField)), "context fields");

  return { path: absPath, stages };
}

export function getStageWorkItems(stage: WorkflowStage): WorkflowWorkItem[] {
  if (stage.checkpoints?.length) return stage.checkpoints;
  return [{
    id: stage.id,
    title: stage.title,
    contextField: stage.contextField!,
    schemaPath: stage.schemaPath!,
    prompt: stage.prompt,
    referenceQueries: stage.referenceQueries,
  }];
}

export function getStageOrder(workflow: WorkflowConfig): string[] {
  return workflow.stages.map((stage) => stage.id);
}

export function getStageContextFields(stage: WorkflowStage): string[] {
  return getStageWorkItems(stage).map((item) => item.contextField);
}

export function getWorkflowContextFields(workflow: WorkflowConfig): string[] {
  return workflow.stages.flatMap(getStageContextFields);
}

export function getOutputFields(workflow: WorkflowConfig): Record<string, string> {
  return Object.fromEntries(workflow.stages.map((stage) => {
    const fields = getStageContextFields(stage);
    return [stage.id, fields[fields.length - 1]];
  }));
}

export function getStageById(workflow: WorkflowConfig, stageId: string): WorkflowStage | undefined {
  return workflow.stages.find((stage) => stage.id === stageId);
}

export function getStageIndex(workflow: WorkflowConfig, stageId: string): number {
  return workflow.stages.findIndex((stage) => stage.id === stageId);
}

export function getStageNumber(workflow: WorkflowConfig, stageId: string): number {
  const index = getStageIndex(workflow, stageId);
  return index >= 0 ? index + 1 : Number.NaN;
}

export function findFirstIncompleteWorkItemIndex(stage: WorkflowStage, context: Record<string, unknown>): number {
  const workItems = getStageWorkItems(stage);
  const index = workItems.findIndex((item) => {
    const value = context[item.contextField];
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  });
  return index === -1 ? workItems.length : index;
}

export function formatWorkItemPrompt(workItem: WorkflowWorkItem): string {
  return [
    `# ${workItem.title}`,
    "",
    workItem.prompt.trim(),
    "",
    "调用 finishWork 时，提交的 JSON 必须符合下方 JSON Schema。",
  ].join("\n");
}
