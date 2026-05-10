import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { validateStageOutput } from "../src/contract.js";
import { getStageWorkItems, loadWorkflowConfig } from "../src/workflow-config.js";
import { discoverTestCases, parseTestsetArgs } from "../src/testset-pipeline.js";
import { resolveConfiguredApiKey } from "../src/config/pi-config.js";
import { buildInvalidJsonDiagnostic } from "../src/tools/general-tools.js";

function resolveRef(schema: any, root: any): any {
  const ref = schema?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  return ref.slice(2).split("/").reduce((current: any, part: string) => current?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function mergeObjectSchemas(schemas: any[], root: any): any {
  return schemas.reduce((merged, item) => {
    const resolved = resolveRef(item, root) ?? item;
    return {
      ...merged,
      ...resolved,
      required: [...new Set([...(merged.required ?? []), ...(resolved.required ?? [])])],
      properties: { ...(merged.properties ?? {}), ...(resolved.properties ?? {}) },
    };
  }, {} as any);
}

function sampleValue(schema: any, root = schema): unknown {
  schema = resolveRef(schema, root) ?? schema;
  if (Array.isArray(schema?.oneOf)) schema = resolveRef(schema.oneOf[0], root) ?? schema.oneOf[0];
  if (Array.isArray(schema?.anyOf)) schema = resolveRef(schema.anyOf[0], root) ?? schema.anyOf[0];
  if (Array.isArray(schema?.allOf)) schema = mergeObjectSchemas(schema.allOf, root);
  if ("const" in (schema ?? {})) return schema.const;
  if (schema?.enum?.length) return schema.enum[0];
  switch (schema?.type) {
    case "string": return "example";
    case "number": return 1;
    case "integer": return 1;
    case "boolean": return true;
    case "array": return [];
    case "object": return payloadForSchema(schema, root);
    default: return {};
  }
}

function payloadForSchema(schema: any, root = schema): Record<string, unknown> {
  schema = resolveRef(schema, root) ?? schema;
  if (Array.isArray(schema?.oneOf)) schema = resolveRef(schema.oneOf[0], root) ?? schema.oneOf[0];
  if (Array.isArray(schema?.anyOf)) schema = resolveRef(schema.anyOf[0], root) ?? schema.anyOf[0];
  if (Array.isArray(schema?.allOf)) schema = mergeObjectSchemas(schema.allOf, root);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties ?? {};
  return Object.fromEntries(required.map((field: string) => [field, sampleValue(properties[field], root)]));
}

describe("workflow topology", () => {
  test("defines the expected SubAgent chain", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    expect(workflow.stages.map((stage) => stage.id)).toEqual(["stage-123", "stage-4", "stage-5", "stage-6"]);
    expect(workflow.stages[0].paperContext).toBe(true);
    expect(workflow.stages[0].systemPrompt).toContain("输入材料为描述化学测量实验的文本");
    expect(workflow.stages[1].systemPrompt).toContain("输入为 checkpoint 3");
    expect(workflow.stages[2].systemPrompt).toContain("输入为 stage-4");
    expect(workflow.stages[3].systemPrompt).toContain("输入为 stage-5");
    expect(getStageWorkItems(workflow.stages[0]).map((item) => item.contextField)).toEqual([
      "stage1_measurand",
      "stage2_measurement_model",
      "stage3_uncertainty_sources",
    ]);
    expect(workflow.stages[1].inputContextField).toBe("stage3_uncertainty_sources");
    expect(workflow.stages[2].inputContextField).toBe("stage4_quantification");
    expect(workflow.stages[3].inputContextField).toBe("stage5_synthesis_expanded");
  });
});

describe("pi model config", () => {
  test("supports literal API keys in provider config", () => {
    expect(resolveConfiguredApiKey("sk-test-direct", {})).toBe("sk-test-direct");
  });

  test("supports environment variable API keys in provider config", () => {
    expect(resolveConfiguredApiKey("TEST_API_KEY", { TEST_API_KEY: "env-secret" })).toBe("env-secret");
  });
});

describe("schema diagnostics", () => {
  test("expands oneOf branch failures", () => {
    const schema = {
      definitions: {
        a: { type: "object", required: ["kind"], properties: { kind: { const: "A" }, value: { type: "number" } } },
        b: { type: "object", required: ["kind", "name"], properties: { kind: { const: "B" }, name: { type: "string" } } },
      },
      oneOf: [{ $ref: "#/definitions/a" }, { $ref: "#/definitions/b" }],
    };
    const result = validateStageOutput("stage-4", { kind: "C", value: "bad" }, {}, { schema });
    expect(result.valid).toBe(false);
    expect(result.violations[0].message).toContain("oneOf");
    expect(result.violations[0].message).toContain("#/definitions/a");
    expect(result.violations[0].message).toContain("#/definitions/b");
    expect(result.violations[0].message).toContain("/kind");
  });
});

describe("finishWork diagnostics", () => {
  test("reports parse position and local context for invalid JSON", () => {
    const diagnostic = buildInvalidJsonDiagnostic(
      '{"measurement_model":{"output_symbol":"mx","input_parameters":[{"symbol":"ms"}',
      new SyntaxError("Expected ',' or ']' after array element in JSON at position 74"),
    );
    expect(diagnostic.position).toBe(74);
    expect(diagnostic.message).toContain("position 74");
    expect(diagnostic.message).toContain("<-- parse failed near here");
    expect(diagnostic.message).toContain("payload length");
  });
});

describe("atomic testset pipeline", () => {
  test("discovers input-ready cases with requirements", async () => {
    const cases = await discoverTestCases(process.cwd(), "input/atomic-steps-testset-input", "UA-001-balance-tare");
    expect(cases.map((c) => c.id)).toEqual(["UA-001-balance-tare"]);
    expect(cases[0].procedurePath.endsWith("procedure.md")).toBe(true);
    expect(cases[0].requirementsPath.endsWith("requirements.txt")).toBe(true);
  });

  test("supports selecting one case from the CLI", () => {
    const args = parseTestsetArgs(["--case=UA-001-balance-tare", "--model=provider/model", "--output=tmp/out"]);
    expect(args.root).toBe("input/atomic-steps-testset-input");
    expect(args.caseId).toBe("UA-001-balance-tare");
    expect(args.model).toBe("provider/model");
    expect(args.outputDir).toBe("tmp/out");
    expect(args.workers).toBe(4);
  });

  test("supports worker count from the CLI", () => {
    const args = parseTestsetArgs(["--workers=2"]);
    expect(args.workers).toBe(2);
  });

  test("supports selecting case ranges from the CLI", () => {
    const args = parseTestsetArgs(["--from=UA-010-manual-crushing", "--to=UA-012-random-subsampling"]);
    expect(args.fromCaseId).toBe("UA-010-manual-crushing");
    expect(args.toCaseId).toBe("UA-012-random-subsampling");
  });

  test("supports resume/skip-done flag", () => {
    const args = parseTestsetArgs(["--resume"]);
    expect(args.resume).toBe(true);
  });

  test("supports disabling requirements review", () => {
    const args = parseTestsetArgs(["--no-review"]);
    expect(args.review).toBe(false);
  });

  test("supports a separate requirements review model", () => {
    const args = parseTestsetArgs(["--model=qwen/qwen3.6-flash", "--review-model=kimi/kimi-for-coding"]);
    expect(args.model).toBe("qwen/qwen3.6-flash");
    expect(args.reviewModel).toBe("kimi/kimi-for-coding");
  });

  test("supports forcing review reruns during resume", () => {
    const args = parseTestsetArgs(["--resume", "--rerun-review"]);
    expect(args.resume).toBe(true);
    expect(args.rerunReview).toBe(true);
  });

  test("defaults to stopping before stage-6", () => {
    const args = parseTestsetArgs([]);
    expect(args.endAt).toBe(3);
  });

  test("can enable stage-6 explicitly", () => {
    const args = parseTestsetArgs(["--with-stage6"]);
    expect(args.endAt).toBe(4);
  });
});

describe("configured reference queries", () => {
  test("each work item has fixed reference queries", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    for (const stage of workflow.stages) {
      for (const item of getStageWorkItems(stage)) {
        expect(item.referenceQueries?.length).toBeGreaterThan(0);
        for (const query of item.referenceQueries ?? []) {
          expect(query.id).toBeTruthy();
          expect(query.query).toBeTruthy();
          expect(["relation", "simple", undefined]).toContain(query.mode);
        }
      }
    }
  });
});

describe("configured JSON schemas", () => {
  test("each work item has a schema that accepts its required fields", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    for (const stage of workflow.stages) {
      for (const item of getStageWorkItems(stage)) {
        expect(item.schemaPath).toBeTruthy();
        const schema = JSON.parse(await fs.readFile(item.schemaPath, "utf-8"));
        expect(validateStageOutput(item.id, payloadForSchema(schema), {}, { schema }).violations).toEqual([]);
      }
    }
  });

  test("checkpoint 3 expresses repeated inputs through correlation coefficients", async () => {
    const schema = JSON.parse(await fs.readFile("config/schemas/checkpoint-3-uncertainty-sources.schema.json", "utf-8"));
    expect(schema.definitions.measurement_protocol.required).not.toContain("occurrence_count");
    expect(schema.definitions.measurement_protocol.properties.occurrence_count).toBeUndefined();
    expect(schema.definitions.composite_aggregated_node.allOf[1].properties.node_content.required).toEqual(["sub_components"]);
    expect(schema.definitions.composite_aggregated_node.allOf[1].properties.node_content.properties.aggregation_plan).toBeUndefined();
    expect(schema.definitions.quantification_source.properties.quantification_raw_data.required).toContain("influence_mechanism");
    expect(schema.definitions.influence_mechanism.oneOf).toEqual([
      { $ref: "#/definitions/single_input_quantity_mechanism" },
      { $ref: "#/definitions/multiple_input_quantity_mechanism" },
    ]);
    expect(schema.definitions.single_input_quantity_mechanism.required).toEqual(["input_quantity_set"]);
    expect(schema.definitions.multiple_input_quantity_mechanism.required).toEqual(["input_quantity_set", "correlation"]);
    expect(schema.definitions.single_input_quantity_set.properties.count.const).toBe(1);
    expect(schema.definitions.multiple_input_quantity_set.properties.count.minimum).toBe(2);
    expect(schema.definitions.input_quantity_correlation.required).toEqual(["coefficient_between_distinct_inputs"]);
    expect(schema.definitions.scalar_input_quantity).toBeUndefined();
    expect(schema.definitions.independent_input_quantity_vector).toBeUndefined();
  });

  test("final report fields belong to stage 6", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    const stage5Schema = JSON.parse(await fs.readFile(workflow.stages[2].schemaPath!, "utf-8"));
    const stage6Schema = JSON.parse(await fs.readFile(workflow.stages[3].schemaPath!, "utf-8"));
    expect(stage5Schema.properties.final_statement).toBeUndefined();
    expect(stage5Schema.required).not.toContain("final_statement");
    expect(stage6Schema.properties.final_statement).toBeTruthy();
    expect(stage6Schema.required).toContain("final_statement");
  });

  test("schemas reject missing required fields", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    const item = getStageWorkItems(workflow.stages[0])[0];
    const schema = JSON.parse(await fs.readFile(item.schemaPath, "utf-8"));
    const result = validateStageOutput(item.id, {}, {}, { schema });
    expect(result.violations.map((v) => v.path)).toContain("/clear_statement");
  });
});
