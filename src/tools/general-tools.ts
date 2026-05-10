/**
 * Tools available to pipeline agents.
 *
 * Agents receive three capabilities:
 * - finishWork: submit the current JSON work product, validate it, and advance the workflow
 * - search_reference: retrieve standard/reference material
 * - calculate: structured numerical operations for uncertainty evaluation
 */
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ContextManager } from "../context-manager.js";
import type { PipelineContext } from "../stages.js";
import { validateStageOutput, formatViolations, type JsonSchema } from "../contract.js";
import { formatWorkItemPrompt, getStageWorkItems } from "../workflow-config.js";
import type { WorkflowStage, WorkflowWorkItem } from "../workflow-config.js";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";

// ── shared helpers ──────────────────────────────────────

function jsonText(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function errorResult(message: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: { error: true, ...details },
  };
}

function extractJsonErrorPosition(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/position (\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export function buildInvalidJsonDiagnostic(content: string, error: unknown): { message: string; position?: number; excerpt: string } {
  const parseMessage = error instanceof Error ? error.message : String(error);
  const position = extractJsonErrorPosition(error);
  const center = position ?? 0;
  const start = Math.max(0, center - 240);
  const end = Math.min(content.length, center + 240);
  const excerpt = content.slice(start, end);
  const pointer = position === undefined ? "" : `\n${" ".repeat(Math.max(0, position - start))}^ <-- parse failed near here`;
  const message = [
    "Invalid JSON submitted to finishWork.",
    `Parser error: ${parseMessage}`,
    `payload length: ${content.length} chars`,
    position === undefined ? "parse position: unavailable" : `parse position: ${position}`,
    "excerpt around failure:",
    excerpt + pointer,
  ].join("\n");
  return { message, position, excerpt };
}

async function writeInvalidJsonPayload(outputDir: string, stageId: string, checkpointId: string, content: string): Promise<string> {
  const dir = path.join(outputDir, "invalid-json");
  await fs.mkdir(dir, { recursive: true });
  const safeCheckpoint = checkpointId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${stageId}_${safeCheckpoint}_${ts}.json.txt`);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

// ── finishWork ──────────────────────────────────────────

export interface FinishWorkState {
  currentIndex: number;
  completed: boolean;
  writtenFields: string[];
}

async function loadJsonSchema(workDir: string, schemaPath: string): Promise<JsonSchema> {
  const absPath = path.resolve(workDir, schemaPath);
  return JSON.parse(await fs.readFile(absPath, "utf-8")) as JsonSchema;
}

function formatJsonBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

async function formatReferenceQueriesBlock(referenceQueryUrl: string, workItem: WorkflowWorkItem): Promise<string | undefined> {
  if (!workItem.referenceQueries?.length) return undefined;

  const blocks: string[] = [];
  for (const query of workItem.referenceQueries) {
    const limit = query.limit ?? 8;
    const result = await runReferenceSearch(referenceQueryUrl, { query: query.query, limit });
    blocks.push([
      `### ${query.id}`,
      `query: ${query.query}`,
      `top_k: ${limit}`,
      formatJsonBlock(result),
    ].join("\n\n"));
  }

  return ["## 检索依据", ...blocks].join("\n\n");
}

async function formatWorkItemInstruction(pipelineContext: PipelineContext, workItem: WorkflowWorkItem): Promise<string> {
  const schemaText = await fs.readFile(path.resolve(pipelineContext.workDir, workItem.schemaPath), "utf-8");
  const referenceBlock = await formatReferenceQueriesBlock(pipelineContext.referenceQueryUrl, workItem);
  const workItemBlock = [
    formatWorkItemPrompt(workItem),
    "",
    "## JSON Schema",
    "",
    "```json",
    schemaText.trim(),
    "```",
  ].join("\n");
  return [referenceBlock, workItemBlock].filter((part): part is string => Boolean(part)).join("\n\n---\n\n");
}

function currentWorkItem(stage: WorkflowStage, state: FinishWorkState): WorkflowWorkItem | undefined {
  return getStageWorkItems(stage)[state.currentIndex];
}

export function makeFinishWorkTool(
  contextManager: ContextManager,
  pipelineContext: PipelineContext,
  stage: WorkflowStage,
  state: FinishWorkState,
): AgentTool {
  const initial = currentWorkItem(stage, state);
  return {
    name: "finishWork",
    label: "Finish Work",
    description:
      "Submit the current JSON work product for " + (initial?.title ?? stage.title) + ". " +
      "The tool validates the JSON against the configured schema, writes the accepted product, and returns the next checkpoint when more work remains. " +
      "Call finishWork only when the current checkpoint/stage JSON is ready.",
    parameters: Type.Object({
      content: Type.String({ description: "A valid JSON string for the current checkpoint or stage work product." }),
    }),
    execute: async (_id, params: any) => {
      const workItem = currentWorkItem(stage, state);
      if (!workItem) {
        state.completed = true;
        return jsonText({ ok: true, stage_complete: true, stage: stage.id });
      }

      const content = String(params.content ?? "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        const diagnostic = buildInvalidJsonDiagnostic(content, e);
        let payloadPath: string | undefined;
        try {
          payloadPath = await writeInvalidJsonPayload(pipelineContext.outputDir, stage.id, workItem.id, content);
        } catch {
          payloadPath = undefined;
        }
        const message = payloadPath ? `${diagnostic.message}\nfull payload saved: ${payloadPath}` : diagnostic.message;
        return errorResult(message, { reason: "invalid_json", checkpoint: workItem.id, position: diagnostic.position, payloadPath });
      }

      await contextManager.load();
      let schema: JsonSchema | undefined;
      try {
        schema = workItem.schemaPath ? await loadJsonSchema(pipelineContext.workDir, workItem.schemaPath) : undefined;
      } catch (e: any) {
        return errorResult("Schema could not be loaded: " + (e.message ?? e), { schemaPath: workItem.schemaPath, checkpoint: workItem.id });
      }

      const result = validateStageOutput(workItem.id, parsed, contextManager.getAll(), {
        schema,
        schemaPath: workItem.schemaPath,
      });
      if (!result.valid) {
        const msg = formatViolations(workItem.id, result.violations, workItem.schemaPath);
        return { content: [{ type: "text", text: msg }], details: { error: "schema_violation", checkpoint: workItem.id, violations: result.violations } };
      }

      const nextIndex = state.currentIndex + 1;
      const workItems = getStageWorkItems(stage);
      const next = workItems[nextIndex];
      let nextInstruction: string | undefined;
      if (next) {
        try {
          nextInstruction = await formatWorkItemInstruction(pipelineContext, next);
        } catch (e: any) {
          return errorResult(`Next checkpoint reference preparation failed: ${e.message ?? e}`, { checkpoint: next.id });
        }
      }

      contextManager.setField(workItem.contextField as any, parsed as any);
      await contextManager.save();
      state.writtenFields.push(workItem.contextField);

      if (next) {
        state.currentIndex = nextIndex;
        return jsonText({
          ok: true,
          stage: stage.id,
          accepted_checkpoint: workItem.id,
          written_field: workItem.contextField,
          next_checkpoint: {
            id: next.id,
            title: next.title,
            instruction: nextInstruction,
          },
        });
      }

      state.completed = true;
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          stage: stage.id,
          accepted_checkpoint: workItem.id,
          written_field: workItem.contextField,
          stage_complete: true,
        }, null, 2) }],
        details: { ok: true, stage: stage.id, accepted_checkpoint: workItem.id, written_field: workItem.contextField, stage_complete: true },
        terminate: true,
      };
    },
  };
}

// ── search_reference: StandardRAG /query-tree ───────────

export interface SearchReferenceRequest {
  query: string;
  limit?: number;
}

const RETRIEVAL_METADATA_KEYS = new Set(["metadata", "source_id", "file_path", "created_at", "chunk_id", "reference_id", "weight", "score", "rank", "distance"]);

function stripRetrievalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(stripRetrievalMetadata)
      .filter((item) => !(item && typeof item === "object" && Object.keys(item).length === 0));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !RETRIEVAL_METADATA_KEYS.has(key))
      .map(([key, nested]) => [key, stripRetrievalMetadata(nested)]),
  );
}

function postJson(url: string, body: unknown, timeoutMs = 180_000): Promise<any> {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.write(payload);
    req.end();
  });
}

export async function runReferenceSearch(referenceQueryUrl: string, params: SearchReferenceRequest): Promise<unknown> {
  const limit = Math.min(30, Math.max(1, Number(params.limit ?? 8)));
  const payload = {
    question: params.query,
    top_k: limit,
  };
  const response = await postJson(referenceQueryUrl, payload);
  const data = stripRetrievalMetadata(response) as any;
  return {
    status: "ok",
    message: "StandardRAG query-tree result",
    summary: {
      hits: Array.isArray(data.hits) ? data.hits.length : 0,
      top_k: payload.top_k,
    },
    data,
  };
}

export function makeSearchReferenceTool(referenceQueryUrl: string): AgentTool {
  return {
    name: "search_reference",
    label: "Search Reference Standards",
    description:
      "Search standards, guides, normative methods, and metrology reference material. " +
      "Write query as a complete natural-language question about methods, definitions, equations, reporting practice, or uncertainty evaluation principles. " +
      "Use general chemical-measurement and metrology terminology that standards can answer directly, such as measurand, measurement model, input quantity, influence quantity, Type A/Type B evaluation, standard uncertainty, sensitivity coefficient, combined standard uncertainty, coverage factor, uncertainty budget, calibration curve, recovery, blank correction, repeatability, or volumetric/gravimetric operation. " +
      "Do not include case-specific sample names, analyte names, instrument brands, article sections, raw numeric values, or bespoke procedure wording in the query; first translate them into the closest general chemical measurement concept. " +
      "Do not use this tool to search for input material facts, sample data, experimental values, missing raw data, DOI/title/author information, or information absent from the current pipeline input artifacts. " +
      "The tool queries StandardRAG /query-tree and returns tree-expanded full-text block hits. " +
      "You may search multiple times freely.",
    parameters: Type.Object({
      query: Type.String({ minLength: 3, description: "A complete natural-language question using general chemical-measurement/metrology terminology that standards can answer directly. Translate case-specific facts into general concepts; do not include sample names, analyte names, brands, article sections, raw numeric values, bespoke procedure wording, or experimental values." }),
      limit: Type.Optional(Type.Number({ description: "Maximum tree hits; sent as StandardRAG top_k. Default: 8, max: 30.", minimum: 1, maximum: 30 })),
    }),
    execute: async (_id, params: any) => {
      try {
        return jsonText(await runReferenceSearch(referenceQueryUrl, params as SearchReferenceRequest));
      } catch (e: any) {
        return errorResult(`search_reference failed: ${e.message ?? e}`, {});
      }
    },
  };
}

// ── calculate: structured math/stat operations ──────────

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function requireArray(value: unknown, name: string, min = 1): number[] {
  if (!Array.isArray(value) || value.length < min || !value.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`${name} must be an array of at least ${min} finite numbers`);
  }
  return value as number[];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values: number[], avg = mean(values)): number {
  if (values.length < 2) throw new Error("sample_sd requires at least 2 values");
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(value: number, digits = 12): number {
  return Number(value.toPrecision(digits));
}

function distributionK(distribution: string | undefined): number | undefined {
  const normalized = distribution?.toLowerCase().replace(/-/g, "_");
  if (!normalized) return undefined;
  if (normalized === "normal" || normalized === "normal_k2") return 2;
  if (normalized === "normal_k3") return 3;
  if (normalized === "rectangular" || normalized === "uniform") return Math.sqrt(3);
  if (normalized === "triangular") return Math.sqrt(6);
  if (normalized === "u_shaped" || normalized === "arcsine") return Math.sqrt(2);
  if (normalized === "two_point") return 1;
  return undefined;
}

function repeatedConcentrations(concentrations: number[], replicatesPerLevel: number | undefined, totalN: number): number[] {
  if (concentrations.length === totalN) return concentrations;
  const repeat = replicatesPerLevel ?? (totalN % concentrations.length === 0 ? totalN / concentrations.length : 1);
  return concentrations.flatMap((value) => Array.from({ length: repeat }, () => value));
}

function linearRegression(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < 2) throw new Error("linear_regression requires x and y arrays with the same length >= 2");
  const n = x.length;
  const xbar = mean(x);
  const ybar = mean(y);
  const sxx = x.reduce((sum, xi) => sum + (xi - xbar) ** 2, 0);
  if (sxx <= 0) throw new Error("linear_regression requires varying x values");
  const sxy = x.reduce((sum, xi, i) => sum + (xi - xbar) * (y[i] - ybar), 0);
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  const residuals = y.map((yi, i) => yi - (slope * x[i] + intercept));
  const sse = residuals.reduce((sum, r) => sum + r ** 2, 0);
  const residualSd = n > 2 ? Math.sqrt(sse / (n - 2)) : null;
  const sst = y.reduce((sum, yi) => sum + (yi - ybar) ** 2, 0);
  const rSquared = sst > 0 ? 1 - sse / sst : 1;
  return { n, slope, intercept, residual_sd: residualSd, r_squared: rSquared, x_mean: xbar, y_mean: ybar, sxx };
}

function evalFormula(formula: string, point: Record<string, number>): number {
  let expr = formula.replace(/^[^=]*=/, "").trim()
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/\^/g, "**")
    .replace(/\bsqrt\(/g, "Math.sqrt(")
    .replace(/\babs\(/g, "Math.abs(")
    .replace(/\blog\(/g, "Math.log10(")
    .replace(/\bln\(/g, "Math.log(")
    .replace(/\bexp\(/g, "Math.exp(")
    .replace(/\bsin\(/g, "Math.sin(")
    .replace(/\bcos\(/g, "Math.cos(")
    .replace(/\btan\(/g, "Math.tan(");
  for (const [name, value] of Object.entries(point).sort((a, b) => b[0].length - a[0].length)) {
    expr = expr.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), String(value));
  }
  if (!/^[0-9+\-*/().,\sEeMathsqrtabslocginp]+$/.test(expr)) {
    throw new Error(`formula contains unsupported tokens after substitution: ${expr}`);
  }
  const result = Function("Math", `"use strict"; return (${expr})`)(Math);
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`formula result is not finite: ${result}`);
  return result;
}

function tFactor95(dof: number): number {
  if (dof <= 0) throw new Error("degrees_of_freedom must be > 0");
  const table: Array<[number, number]> = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571],
    [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228],
    [11, 2.201], [12, 2.179], [13, 2.160], [14, 2.145], [15, 2.131],
    [16, 2.120], [17, 2.110], [18, 2.101], [19, 2.093], [20, 2.086],
    [21, 2.080], [22, 2.074], [23, 2.069], [24, 2.064], [25, 2.060],
    [26, 2.056], [27, 2.052], [28, 2.048], [29, 2.045], [30, 2.042],
    [40, 2.021], [50, 2.009], [60, 2.000], [80, 1.990], [100, 1.984],
  ];
  if (dof >= 100) return 1.984;
  const exact = table.find(([nu]) => nu === dof);
  if (exact) return exact[1];
  const lower = [...table].reverse().find(([nu]) => nu < dof);
  const upper = table.find(([nu]) => nu > dof);
  if (!lower) return table[0][1];
  if (!upper) return 1.984;
  return lower[1] + (upper[1] - lower[1]) * ((dof - lower[0]) / (upper[0] - lower[0]));
}

function roundToSig(value: number, sig: number): number {
  if (value === 0) return 0;
  const digits = sig - Math.floor(Math.log10(Math.abs(value))) - 1;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function decimalPlaces(value: number): number {
  const s = value.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  return dot >= 0 ? s.length - dot - 1 : 0;
}

export function makeCalculateTool(): AgentTool {
  return {
    name: "calculate",
    label: "Calculate",
    description:
      "Run a structured mathematical/statistical operation for uncertainty evaluation. " +
      "Choose one operation and provide the required numeric fields. " +
      "Supported operations: arithmetic, mean, sample_sd, standard_error, rsd, linear_regression, calibration_uncertainty, standard_uncertainty_from_half_width, standard_uncertainty_from_expanded, rss, correlated_combination, numeric_sensitivity, welch_satterthwaite, t_factor_95, round_uncertainty_report. " +
      "For basic arithmetic, set operation='arithmetic' and choose operator='add'|'subtract'|'multiply'|'divide'|'power'|'sqrt'|'abs'. " +
      "Square root example: { operation: 'arithmetic', operator: 'sqrt', operands: [0.1187523003] }.",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("arithmetic"), Type.Literal("mean"), Type.Literal("sample_sd"), Type.Literal("standard_error"), Type.Literal("rsd"),
        Type.Literal("linear_regression"), Type.Literal("calibration_uncertainty"),
        Type.Literal("standard_uncertainty_from_half_width"), Type.Literal("standard_uncertainty_from_expanded"),
        Type.Literal("rss"), Type.Literal("correlated_combination"), Type.Literal("numeric_sensitivity"),
        Type.Literal("welch_satterthwaite"), Type.Literal("t_factor_95"), Type.Literal("round_uncertainty_report"),
      ], { description: "The calculation operation to run." }),
      operator: Type.Optional(Type.Union([
        Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide"),
        Type.Literal("power"), Type.Literal("sqrt"), Type.Literal("abs"),
      ], { description: "Operator for arithmetic. add/multiply accept one or more operands; subtract/divide/power require exactly two; sqrt/abs require exactly one." })),
      operands: Type.Optional(Type.Array(Type.Number(), { description: "Operands for arithmetic." })),
      values: Type.Optional(Type.Array(Type.Number(), { description: "Numeric values for mean/sample_sd/standard_error/rsd/rss." })),
      x: Type.Optional(Type.Array(Type.Number(), { description: "x values for linear_regression." })),
      y: Type.Optional(Type.Array(Type.Number(), { description: "y values for linear_regression or calibration residual calculation." })),
      sd: Type.Optional(Type.Number({ description: "Known sample standard deviation, for standard_error/rsd." })),
      n: Type.Optional(Type.Number({ description: "Observation count, for standard_error/calibration_uncertainty." })),
      mean: Type.Optional(Type.Number({ description: "Known mean, for rsd." })),
      half_width: Type.Optional(Type.Number({ description: "Half-width a for B-type u=a/k conversion." })),
      expanded_uncertainty: Type.Optional(Type.Number({ description: "Expanded uncertainty U for u=U/k conversion." })),
      k: Type.Optional(Type.Number({ description: "Coverage/divisor factor k." })),
      distribution: Type.Optional(Type.String({ description: "Distribution name when k is not given: normal, normal_k3, rectangular, triangular, u-shaped, two-point." })),
      slope: Type.Optional(Type.Number({ description: "Calibration slope." })),
      intercept: Type.Optional(Type.Number({ description: "Calibration intercept, needed if residual_sd is computed from y." })),
      residual_sd: Type.Optional(Type.Number({ description: "Residual standard deviation s_y for calibration_uncertainty." })),
      sample_concentration: Type.Optional(Type.Number({ description: "Sample concentration x0 for calibration_uncertainty." })),
      calibration_concentrations: Type.Optional(Type.Array(Type.Number(), { description: "Calibration x levels for calibration_uncertainty." })),
      p: Type.Optional(Type.Number({ description: "Number of replicate sample measurements in calibration_uncertainty." })),
      replicates_per_level: Type.Optional(Type.Number({ description: "Replicates per calibration level if y length expands x levels." })),
      contributions: Type.Optional(Type.Array(Type.Number(), { description: "Uncertainty contributions for correlated_combination or welch_satterthwaite." })),
      degrees_of_freedom: Type.Optional(Type.Union([Type.Number(), Type.Array(Type.Number())], { description: "One dof for t_factor_95, or an array matching contributions for welch_satterthwaite." })),
      correlation_matrix: Type.Optional(Type.Array(Type.Array(Type.Number()), { description: "Square correlation matrix for correlated_combination." })),
      formula: Type.Optional(Type.String({ description: "Formula for numeric_sensitivity, e.g. 'm = rho * V * f * 1e-3'." })),
      variable: Type.Optional(Type.String({ description: "Variable name for numeric_sensitivity." })),
      point: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Point values for numeric_sensitivity." })),
      step: Type.Optional(Type.Number({ description: "Optional finite-difference step for numeric_sensitivity." })),
      value: Type.Optional(Type.Number({ description: "Measured value for round_uncertainty_report." })),
      uncertainty: Type.Optional(Type.Number({ description: "Uncertainty value for round_uncertainty_report." })),
    }),
    execute: async (_id, params: any) => {
      try {
        const op = params.operation as string;
        let result: Record<string, unknown>;
        switch (op) {
          case "arithmetic": {
            const operator = String(params.operator ?? "");
            const operands = requireArray(params.operands, "operands", 1);
            let value: number;
            let formula: string;
            switch (operator) {
              case "add":
                value = operands.reduce((sum, x) => sum + x, 0);
                formula = "sum(operands)";
                break;
              case "subtract":
                if (operands.length !== 2) throw new Error("subtract requires exactly 2 operands");
                value = operands[0] - operands[1];
                formula = "a - b";
                break;
              case "multiply":
                value = operands.reduce((product, x) => product * x, 1);
                formula = "product(operands)";
                break;
              case "divide":
                if (operands.length !== 2) throw new Error("divide requires exactly 2 operands");
                if (operands[1] === 0) throw new Error("division by zero");
                value = operands[0] / operands[1];
                formula = "a / b";
                break;
              case "power":
                if (operands.length !== 2) throw new Error("power requires exactly 2 operands");
                value = operands[0] ** operands[1];
                formula = "a ** b";
                break;
              case "sqrt":
                if (operands.length !== 1) throw new Error("sqrt requires exactly 1 operand");
                if (operands[0] < 0) throw new Error("sqrt operand must be non-negative");
                value = Math.sqrt(operands[0]);
                formula = "sqrt(a)";
                break;
              case "abs":
                if (operands.length !== 1) throw new Error("abs requires exactly 1 operand");
                value = Math.abs(operands[0]);
                formula = "abs(a)";
                break;
              default:
                throw new Error("arithmetic requires operator: add, subtract, multiply, divide, power, sqrt, or abs");
            }
            result = { result: value, formula, details: { operator, operands } };
            break;
          }
          case "mean": {
            const values = requireArray(params.values, "values", 1);
            result = { result: mean(values), details: { n: values.length } };
            break;
          }
          case "sample_sd": {
            const values = requireArray(params.values, "values", 2);
            const avg = mean(values);
            result = { result: sampleSd(values, avg), formula: "sqrt(sum((x_i - mean)^2) / (n - 1))", details: { n: values.length, mean: avg } };
            break;
          }
          case "standard_error": {
            const values = params.values ? requireArray(params.values, "values", 2) : undefined;
            const sd = values ? sampleSd(values) : requireNumber(params.sd, "sd");
            const n = values ? values.length : requireNumber(params.n, "n");
            result = { result: sd / Math.sqrt(n), formula: "s / sqrt(n)", details: { n, sd } };
            break;
          }
          case "rsd": {
            const values = params.values ? requireArray(params.values, "values", 2) : undefined;
            const avg = values ? mean(values) : requireNumber(params.mean, "mean");
            const sd = values ? sampleSd(values, avg) : requireNumber(params.sd, "sd");
            result = { result: Math.abs(sd / avg), result_percent: Math.abs(sd / avg) * 100, formula: "abs(sd / mean)", details: { mean: avg, sd } };
            break;
          }
          case "linear_regression": {
            result = linearRegression(requireArray(params.x, "x", 2), requireArray(params.y, "y", 2));
            break;
          }
          case "calibration_uncertainty": {
            const concentrations = requireArray(params.calibration_concentrations, "calibration_concentrations", 2);
            const slope = requireNumber(params.slope, "slope");
            const sampleConcentration = requireNumber(params.sample_concentration, "sample_concentration");
            const p = requireNumber(params.p, "p");
            const n = requireNumber(params.n, "n");
            const expandedX = repeatedConcentrations(concentrations, params.replicates_per_level, n);
            const xbar = mean(expandedX);
            const sxx = expandedX.reduce((sum, value) => sum + (value - xbar) ** 2, 0);
            if (sxx <= 0) throw new Error("calibration_concentrations must vary");
            let residualSd = params.residual_sd as number | undefined;
            if (residualSd == null) {
              const y = requireArray(params.y, "y", 2);
              const intercept = requireNumber(params.intercept, "intercept");
              if (y.length !== expandedX.length) throw new Error("y length must match expanded calibration concentrations length");
              residualSd = Math.sqrt(y.reduce((sum, yi, i) => sum + (yi - (slope * expandedX[i] + intercept)) ** 2, 0) / (n - 2));
            }
            const u = (residualSd / slope) * Math.sqrt(1 / p + 1 / n + ((sampleConcentration - xbar) ** 2) / sxx);
            result = { result: u, formula: "(s_y/slope)*sqrt(1/p + 1/n + (x0-xbar)^2/Sxx)", details: { residual_sd: residualSd, slope, p, n, xbar, sxx } };
            break;
          }
          case "standard_uncertainty_from_half_width": {
            const halfWidth = requireNumber(params.half_width, "half_width");
            const k = params.k ?? distributionK(params.distribution);
            if (k == null) throw new Error("provide k or a known distribution");
            result = { result: halfWidth / k, formula: "u = a / k", details: { half_width: halfWidth, k, distribution: params.distribution } };
            break;
          }
          case "standard_uncertainty_from_expanded": {
            const U = requireNumber(params.expanded_uncertainty, "expanded_uncertainty");
            const k = requireNumber(params.k, "k");
            result = { result: U / k, formula: "u = U / k", details: { expanded_uncertainty: U, k } };
            break;
          }
          case "rss": {
            const values = requireArray(params.values, "values", 1);
            result = { result: Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0)), formula: "sqrt(sum(x_i^2))", details: { n: values.length } };
            break;
          }
          case "correlated_combination": {
            const c = requireArray(params.contributions, "contributions", 1);
            const r = params.correlation_matrix as number[][] | undefined;
            if (!Array.isArray(r) || r.length !== c.length || r.some((row) => !Array.isArray(row) || row.length !== c.length || row.some((x) => typeof x !== "number" || !Number.isFinite(x)))) {
              throw new Error("correlation_matrix must be a square numeric matrix matching contributions length");
            }
            let variance = 0;
            for (let i = 0; i < c.length; i++) for (let j = 0; j < c.length; j++) variance += c[i] * c[j] * r[i][j];
            result = { result: Math.sqrt(Math.max(0, variance)), formula: "sqrt(sum_i sum_j c_i*c_j*r_ij)", details: { variance } };
            break;
          }
          case "numeric_sensitivity": {
            const formula = String(params.formula ?? "");
            const variable = String(params.variable ?? "");
            const point = params.point as Record<string, number> | undefined;
            if (!formula || !variable || !point || typeof point[variable] !== "number") throw new Error("numeric_sensitivity requires formula, variable, and point containing that variable");
            const x0 = point[variable];
            const h = params.step ?? Math.max(Math.abs(x0) * 1e-6, 1e-9);
            const plus = { ...point, [variable]: x0 + h };
            const minus = { ...point, [variable]: x0 - h };
            const sensitivity = (evalFormula(formula, plus) - evalFormula(formula, minus)) / (2 * h);
            result = { result: sensitivity, formula: "central finite difference", details: { variable, point, step: h } };
            break;
          }
          case "welch_satterthwaite": {
            const c = requireArray(params.contributions, "contributions", 1).map(Math.abs);
            const dof = params.degrees_of_freedom;
            if (!Array.isArray(dof) || dof.length !== c.length || !dof.every((x) => typeof x === "number" && x > 0)) throw new Error("degrees_of_freedom must be a positive numeric array matching contributions");
            const uc = Math.sqrt(c.reduce((sum, value) => sum + value ** 2, 0));
            const denominator = c.reduce((sum, value, i) => sum + value ** 4 / (dof[i] as number), 0);
            result = { result: uc ** 4 / denominator, formula: "nu_eff = uc^4 / sum(c_i^4/nu_i)", details: { uc, denominator } };
            break;
          }
          case "t_factor_95": {
            const dof = requireNumber(params.degrees_of_freedom, "degrees_of_freedom");
            result = { result: tFactor95(dof), confidence: 0.95, details: { degrees_of_freedom: dof, distribution: "two-sided Student t" } };
            break;
          }
          case "round_uncertainty_report": {
            const value = requireNumber(params.value, "value");
            const uncertainty = requireNumber(params.uncertainty, "uncertainty");
            const firstDigit = Number(String(Math.abs(uncertainty).toExponential(0))[0]);
            const sig = firstDigit <= 2 ? 2 : 1;
            const roundedUncertainty = roundToSig(uncertainty, sig);
            const places = decimalPlaces(roundedUncertainty);
            const factor = 10 ** places;
            const roundedValue = Math.round(value * factor) / factor;
            result = { result: { value: roundedValue, uncertainty: roundedUncertainty }, details: { significant_digits_for_uncertainty: sig, decimal_places: places } };
            break;
          }
          default:
            throw new Error(`Unsupported operation: ${op}`);
        }
        return jsonText({ operation: op, ...JSON.parse(JSON.stringify(result, (_k, v) => typeof v === "number" ? round(v) : v)) });
      } catch (e: any) {
        return errorResult(`Calculation failed: ${e.message ?? e}`, { operation: params.operation });
      }
    },
  };
}
