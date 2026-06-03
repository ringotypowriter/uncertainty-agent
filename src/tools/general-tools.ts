/**
 * Tools available to pipeline agents.
 *
 * Agents receive three capabilities:
 * - finishWork: submit the current JSON work product, validate it, and advance the workflow
 * - search_reference: retrieve standard/reference material
 * - calculate: SymPy-backed symbolic/numeric expression evaluation
 */
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ContextManager } from "../context-manager.js";
import type { PipelineContext } from "../stages.js";
import { validateStageOutput, formatViolations, type JsonSchema } from "../contract.js";
import { getStageWorkItems } from "../workflow-config.js";
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

async function writeInvalidJsonPayload(outputDir: string, stageId: string, workItemId: string, content: string): Promise<string> {
  const dir = path.join(outputDir, "invalid-json");
  await fs.mkdir(dir, { recursive: true });
  const safeWorkItem = workItemId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${stageId}_${safeWorkItem}_${ts}.json.txt`);
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
      "The tool validates the JSON against the configured schema, writes the accepted product, and completes the current stage.",
    parameters: Type.Object({
      content: Type.String({ description: "A valid JSON string for the current stage work product." }),
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
        return errorResult(message, { reason: "invalid_json", workItem: workItem.id, position: diagnostic.position, payloadPath });
      }

      await contextManager.load();
      let schema: JsonSchema | undefined;
      try {
        schema = await loadJsonSchema(pipelineContext.workDir, workItem.schemaPath);
      } catch (e: any) {
        return errorResult("Schema could not be loaded: " + (e.message ?? e), { schemaPath: workItem.schemaPath, workItem: workItem.id });
      }

      const result = validateStageOutput(workItem.id, parsed, contextManager.getAll(), {
        schema,
        schemaPath: workItem.schemaPath,
      });
      if (!result.valid) {
        const msg = formatViolations(workItem.id, result.violations, workItem.schemaPath);
        return { content: [{ type: "text", text: msg }], details: { error: "schema_violation", workItem: workItem.id, violations: result.violations } };
      }

      contextManager.setField(workItem.contextField as any, parsed as any);
      await contextManager.save();
      state.writtenFields.push(workItem.contextField);
      state.completed = true;

      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          stage: stage.id,
          accepted_work_item: workItem.id,
          written_field: workItem.contextField,
          stage_complete: true,
        }, null, 2) }],
        details: { ok: true, stage: stage.id, accepted_work_item: workItem.id, written_field: workItem.contextField, stage_complete: true },
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

// Calculation tools live in sympy-tools.ts.
