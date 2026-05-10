import type { StageId, UncertaintyContext } from "./stages.js";

export interface ContractViolation {
  path: string;
  message: string;
}

export interface ContractResult {
  valid: boolean;
  violations: ContractViolation[];
}

export type JsonSchema = boolean | Record<string, unknown>;

export interface StageOutputContract {
  schema?: JsonSchema;
  schemaPath?: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonPointerPath(path: string): string {
  return path || "/";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  const rawType = schema.type;
  if (Array.isArray(rawType) && rawType.every((item) => typeof item === "string")) return rawType;
  if (typeof rawType === "string") return [rawType];
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isJsonObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolvePointer(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as JsonSchema;
}

function schemaBranchLabel(schema: JsonSchema, index: number): string {
  if (schema && typeof schema === "object" && !Array.isArray(schema) && typeof schema.$ref === "string") return schema.$ref;
  return `branch ${index + 1}`;
}

function summarizeViolations(violations: ContractViolation[], limit = 4): string {
  if (violations.length === 0) return "matched";
  const shown = violations.slice(0, limit).map((v) => `${v.path}: ${v.message}`).join("; ");
  const rest = violations.length > limit ? `; ... ${violations.length - limit} more` : "";
  return shown + rest;
}

function validateSchemaNode(schema: JsonSchema, value: unknown, path: string, root: JsonSchema): ContractViolation[] {
  if (schema === true) return [];
  if (schema === false) return [{ path: jsonPointerPath(path), message: "该位置不接受任何值。" }];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];

  const ref = schema.$ref;
  if (typeof ref === "string") {
    const resolved = resolvePointer(root, ref);
    if (!resolved) return [{ path: jsonPointerPath(path), message: `无法解析 schema 引用 ${ref}。` }];
    return validateSchemaNode(resolved, value, path, root);
  }

  const violations: ContractViolation[] = [];
  const constValue = schema.const;
  if ("const" in schema && !sameJson(value, constValue)) {
    violations.push({ path: jsonPointerPath(path), message: `值必须等于 ${formatValue(constValue)}。` });
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((item) => sameJson(item, value))) {
    violations.push({ path: jsonPointerPath(path), message: `值必须是 enum 中的一个：${enumValues.map(formatValue).join(", ")}。` });
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const pass = anyOf.some((item) => validateSchemaNode(item as JsonSchema, value, path, root).length === 0);
    if (!pass) violations.push({ path: jsonPointerPath(path), message: "值不满足 anyOf 中任一 schema。" });
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const branchResults = oneOf.map((item, index) => ({
      label: schemaBranchLabel(item as JsonSchema, index),
      violations: validateSchemaNode(item as JsonSchema, value, path, root),
    }));
    const matched = branchResults.filter((result) => result.violations.length === 0);
    if (matched.length !== 1) {
      const details = branchResults
        .map((result) => `${result.label}: ${summarizeViolations(result.violations)}`)
        .join(" | ");
      violations.push({
        path: jsonPointerPath(path),
        message: `值必须且只能满足 oneOf 中一个 schema；当前匹配 ${matched.length}/${oneOf.length}。分支诊断：${details}`,
      });
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const item of allOf) violations.push(...validateSchemaNode(item as JsonSchema, value, path, root));
  }

  const types = schemaTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    violations.push({ path: jsonPointerPath(path), message: `类型应为 ${types.join(" | ")}。` });
    return violations;
  }

  if (typeof value === "string") {
    const minLength = schema.minLength;
    if (typeof minLength === "number" && value.length < minLength) {
      violations.push({ path: jsonPointerPath(path), message: `字符串长度不能小于 ${minLength}。` });
    }
    const maxLength = schema.maxLength;
    if (typeof maxLength === "number" && value.length > maxLength) {
      violations.push({ path: jsonPointerPath(path), message: `字符串长度不能大于 ${maxLength}。` });
    }
    const pattern = schema.pattern;
    if (typeof pattern === "string" && !(new RegExp(pattern).test(value))) {
      violations.push({ path: jsonPointerPath(path), message: `字符串不匹配 pattern：${pattern}。` });
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const minimum = schema.minimum;
    if (typeof minimum === "number" && value < minimum) {
      violations.push({ path: jsonPointerPath(path), message: `数值不能小于 ${minimum}。` });
    }
    const maximum = schema.maximum;
    if (typeof maximum === "number" && value > maximum) {
      violations.push({ path: jsonPointerPath(path), message: `数值不能大于 ${maximum}。` });
    }
    const exclusiveMinimum = schema.exclusiveMinimum;
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      violations.push({ path: jsonPointerPath(path), message: `数值必须大于 ${exclusiveMinimum}。` });
    }
    const exclusiveMaximum = schema.exclusiveMaximum;
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      violations.push({ path: jsonPointerPath(path), message: `数值必须小于 ${exclusiveMaximum}。` });
    }
    const multipleOf = schema.multipleOf;
    if (typeof multipleOf === "number" && multipleOf !== 0 && Math.abs(value / multipleOf - Math.round(value / multipleOf)) > 1e-12) {
      violations.push({ path: jsonPointerPath(path), message: `数值必须是 ${multipleOf} 的倍数。` });
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === "number" && value.length < minItems) {
      violations.push({ path: jsonPointerPath(path), message: `数组长度不能小于 ${minItems}。` });
    }
    const maxItems = schema.maxItems;
    if (typeof maxItems === "number" && value.length > maxItems) {
      violations.push({ path: jsonPointerPath(path), message: `数组长度不能大于 ${maxItems}。` });
    }
    const items = schema.items as JsonSchema | JsonSchema[] | undefined;
    if (Array.isArray(items)) {
      for (let i = 0; i < Math.min(value.length, items.length); i++) {
        violations.push(...validateSchemaNode(items[i], value[i], `${path}/${i}`, root));
      }
    } else if (items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        violations.push(...validateSchemaNode(items, value[i], `${path}/${i}`, root));
      }
    }
  }

  if (isJsonObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (typeof field === "string" && !(field in value)) {
          violations.push({ path: `${jsonPointerPath(path)}/${field}`.replace("//", "/"), message: `缺少必填字段 \`${field}\`。` });
        }
      }
    }

    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const [field, childSchema] of Object.entries(properties)) {
      if (field in value) {
        violations.push(...validateSchemaNode(childSchema as JsonSchema, value[field], `${path}/${field}`, root));
      }
    }

    const additionalProperties = schema.additionalProperties;
    for (const field of Object.keys(value)) {
      if (field in properties) continue;
      if (additionalProperties === false) {
        violations.push({ path: `${jsonPointerPath(path)}/${field}`.replace("//", "/"), message: `字段 \`${field}\` 不在 schema 允许范围内。` });
      } else if (additionalProperties && typeof additionalProperties === "object") {
        violations.push(...validateSchemaNode(additionalProperties as JsonSchema, value[field], `${path}/${field}`, root));
      }
    }
  }

  return violations;
}

export function validateStageOutput(
  stageId: StageId,
  data: unknown,
  _ctx?: UncertaintyContext,
  contract: StageOutputContract = {},
): ContractResult {
  const violations = contract.schema
    ? validateSchemaNode(contract.schema, data, "", contract.schema)
    : [{ path: "/", message: `${stageId} 未配置 JSON schema。` }];

  return { valid: violations.length === 0, violations };
}

export function formatViolations(stageId: StageId, violations: ContractViolation[], schemaPath?: string): string {
  const source = schemaPath ? ` schema ${schemaPath}` : " configured schema";
  const items = violations.map((v) => `- ${v.path}: ${v.message}`).join("\n");
  return [`JSON for ${stageId} did not match${source}:`, "", items].filter(Boolean).join("\n");
}

export interface InvariantResult {
  errors: ContractViolation[];
  warnings: ContractViolation[];
}

export interface InvariantCheck {
  id: string;
  stage: StageId;
  type: "error" | "warning";
  description: string;
  check: (data: any, ctx: UncertaintyContext) => ContractViolation[];
}

export const INVARIANTS: InvariantCheck[] = [];

export function checkInvariants(_stageId: StageId, _data: unknown, _ctx: UncertaintyContext): InvariantResult {
  return { errors: [], warnings: [] };
}
