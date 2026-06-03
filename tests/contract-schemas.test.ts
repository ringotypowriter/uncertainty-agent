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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("workflow topology", () => {
  test("defines the expected four-step SubAgent chain", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    expect(workflow.stages.map((stage) => stage.id)).toEqual([
      "measurand-specification",
      "measurement-model",
      "uncertainty-components",
      "synthesis-and-reporting",
    ]);
    expect(workflow.stages[0].paperContext).toBe(true);
    expect(workflow.stages[1].inputContextField).toBe("measurand_specification");
    expect(workflow.stages[2].inputContextField).toBe("measurement_model");
    expect(workflow.stages[3].inputContextField).toBe("uncertainty_components");
    expect(workflow.stages.map((stage) => getStageWorkItems(stage)[0].contextField)).toEqual([
      "measurand_specification",
      "measurement_model",
      "uncertainty_components",
      "synthesis_and_reporting",
    ]);
    for (const stage of workflow.stages) {
      const item = getStageWorkItems(stage)[0];
      expect(item.id).toBe(stage.id);
      expect(item.schemaPath).toContain("config/schemas/four-phase/");
    }
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
    const result = validateStageOutput("sample-stage", { kind: "C", value: "bad" }, {}, { schema });
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

  test("defaults to running all four stages", () => {
    const args = parseTestsetArgs([]);
    expect(args.endAt).toBe(4);
  });

  test("supports stopping before final synthesis/reporting stage", () => {
    const args = parseTestsetArgs(["--end-at=3"]);
    expect(args.endAt).toBe(3);
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

  test("schema directory only contains the four-step schema set", async () => {
    const rootEntries = (await fs.readdir("config/schemas", { withFileTypes: true })).map((entry) => entry.name).sort();
    const fourPhaseEntries = (await fs.readdir("config/schemas/four-phase", { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    expect(rootEntries).toEqual(["four-phase"]);
    expect(fourPhaseEntries).toEqual([
      "01-measurand-and-measurement-information.schema.json",
      "02-measurement-model.schema.json",
      "03-uncertainty-sources-and-quantification.schema.json",
      "04-synthesis-expansion-and-report.schema.json",
    ]);
  });

  test("final report fields belong to the fourth stage", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    const stage3Schema = JSON.parse(await fs.readFile(workflow.stages[2].schemaPath!, "utf-8"));
    const stage4Schema = JSON.parse(await fs.readFile(workflow.stages[3].schemaPath!, "utf-8"));
    expect(stage3Schema.properties.final_statement).toBeUndefined();
    expect(stage3Schema.required).not.toContain("final_statement");
    expect(stage4Schema.properties.report_statement).toBeTruthy();
    expect(stage4Schema.required).toContain("report_statement");
  });

  test("schemas reject missing required fields", async () => {
    const workflow = await loadWorkflowConfig(process.cwd());
    const item = getStageWorkItems(workflow.stages[0])[0];
    const schema = JSON.parse(await fs.readFile(item.schemaPath, "utf-8"));
    const result = validateStageOutput(item.id, {}, {}, { schema });
    expect(result.violations.map((v) => v.path)).toContain("/measurand");
  });
});
