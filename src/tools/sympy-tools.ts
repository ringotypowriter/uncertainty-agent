/**
 * Sympy-backed computation tools for the uncertainty pipeline.
 *
 * Each tool calls the Python engine CLI (engine_cli.py) via subprocess.
 * All tools output JSON; errors are surfaced as tool result content.
 */
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the Python engine CLI. Works from both src/ and compiled dist/. */
const ENGINE_CLI = path.resolve(__dirname, "..", "..", "src", "tools", "engine_cli.py");

async function callEngine(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const argsJson = JSON.stringify(args);
  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [ENGINE_CLI, "--tool", tool, "--args", argsJson],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    if (stderr) {
      console.warn(`[engine:${tool}] stderr:`, stderr.slice(0, 500));
    }
    return JSON.parse(stdout);
  } catch (e: any) {
    const msg = e.stderr || e.message || String(e);
    return {
      ok: false,
      error: `Engine call failed: ${msg.slice(0, 500)}`,
    };
  }
}

// ---- Tool: parse_model ----

export function makeParseModelTool(): AgentTool {
  return {
    name: "parse_model",
    label: "Parse Model",
    description:
      "Parse a measurement equation string (e.g. 'm = rho * V * f * 1e-3') into a structured model with input variables. " +
      "Use this in Stage 2 to verify that a proposed equation is syntactically valid before computing sensitivities.",
    parameters: Type.Object({
      equation: Type.String({
        description:
          "Measurement equation in 'y = f(x1, x2, ...)' format.",
      }),
    }),
    execute: async (_id, params: any) => {
      const result: any = await callEngine("parse_model", {
        equation: params.equation,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Parse failed: ${result.error}` }],
          details: result,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Parsed model: output_var=${result.output_var}, ` +
              `input_vars=[${result.input_vars.join(", ")}], ` +
              `expr=${result.expr}`,
          },
        ],
        details: result,
      };
    },
  };
}

// ---- Tool: compute_sensitivity ----

export function makeComputeSensitivityTool(): AgentTool {
  return {
    name: "compute_sensitivity",
    label: "Compute Sensitivity",
    description:
      "Compute the sensitivity coefficient c_i = ∂f/∂x_i for a single input variable in the measurement model, " +
      "evaluated at a given point. Returns both absolute and relative sensitivity. " +
      "Use this in the measurement-model stage to verify model structure (sensitivities should be physically meaningful) " +
      "and in synthesis-and-reporting to assemble the sensitivity vector for propagation. " +
      "If measurand_value is provided and the equation's output differs by >1%, " +
      "the sensitivity is auto-scaled to match the declared measurand unit.",
    parameters: Type.Object({
      equation: Type.String({
        description:
          "Measurement equation in 'y = f(x1, x2, ...)' format.",
      }),
      variable: Type.String({
        description:
          "Input variable to differentiate with respect to.",
      }),
      point: Type.String({
        description:
          "JSON object of variable values at the evaluation point, e.g. '{\"rho\":46.18,\"V\":25.0}'.",
      }),
      measurand_value: Type.Optional(Type.Number({
        description:
          "The declared measurand value from measurand-specification. If the equation evaluates to a different scale " +
          "(e.g. model outputs a dimensionless fraction but measurand is in percent), the engine auto-scales the sensitivity. " +
          "Pass this when the measurand unit is known.",
      })),
    }),
    execute: async (_id, params: any) => {
      let point: Record<string, number>;
      try {
        point = JSON.parse(params.point);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Invalid JSON for point: ${params.point}`,
            },
          ],
          details: { error: "invalid_json" },
        };
      }
      const engineArgs: Record<string, unknown> = {
        equation: params.equation,
        variable: params.variable,
        point,
      };
      if (params.measurand_value !== undefined) {
        engineArgs.measurand_value = params.measurand_value;
      }
      const result: any = await callEngine("compute_sensitivity", engineArgs);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Sensitivity failed: ${result.error}` }],
          details: result,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `∂(${result.variable}) = ${result.sensitivity} ` +
              `(rel: ${result.relative_sensitivity}) ` +
              `at output=${result.output_value_at_point}`,
          },
        ],
        details: result,
      };
    },
  };
}

// ---- Tool: statistics ----

export function makeStatisticsTool(): AgentTool {
  return {
    name: "statistics",
    label: "Statistics",
    description:
      "Compute descriptive statistics from a numeric array: n, mean, standard deviation, " +
      "RSD (relative standard deviation), and SE (standard error = A-type standard uncertainty). " +
      "Use this for A-type evaluation from repeated measurement data. " +
      "DO NOT use this for single values — use evaluate instead.",
    parameters: Type.Object({
      data: Type.String({
        description:
          "JSON array of numbers, e.g. '[11.48, 11.52, 11.61, 11.45]'.",
      }),
    }),
    execute: async (_id, params: any) => {
      let data: number[];
      try {
        data = JSON.parse(params.data);
        if (!Array.isArray(data) || data.some((v) => typeof v !== "number")) {
          throw new Error("data must be a JSON array of numbers");
        }
      } catch (e: any) {
        return {
          content: [
            { type: "text", text: `Invalid data: ${e.message}` },
          ],
          details: { error: "invalid_data" },
        };
      }
      const result: any = await callEngine("statistics", { data });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Statistics failed: ${result.error}` }],
          details: result,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `n=${result.n}, mean=${result.mean}, std=${result.std}, ` +
              `RSD=${result.rsd}, SE(A-type u)=${result.se}, dof=${result.dof}`,
          },
        ],
        details: result,
      };
    },
  };
}

// ---- Tool: propagate ----

export function makePropagateTool(): AgentTool {
  return {
    name: "propagate",
    label: "Propagate Uncertainty",
    description:
      "Run full GUM uncertainty propagation. Given a measurement equation, evaluation point, " +
      "and component list (each with name, u, type='absolute'|'relative', variable, optional dof), " +
      "computes combined standard uncertainty, component contributions, and effective degrees of freedom. " +
      "Use this in synthesis-and-reporting for uncertainty propagation. " +
      "This is the PRIMARY tool for uncertainty propagation — DO NOT use evaluate to manually propagate. " +
      "If measurand_value is provided and the equation's output differs by >1%, " +
      "all contributions and uc are auto-scaled to match the declared measurand unit.",
    parameters: Type.Object({
      equation: Type.String({
        description:
          "Measurement equation in 'y = f(x1, x2, ...)' format.",
      }),
      point: Type.String({
        description:
          "JSON object of variable values, e.g. '{\"rho\":46.18,\"V\":25.0}'.",
      }),
      components: Type.String({
        description:
          "JSON array of components. Each: {name, u, type: 'absolute'|'relative', variable, dof?}. " +
          "Relative components are automatically expanded using the variable value from point.",
      }),
      measurand_value: Type.Optional(Type.Number({
        description:
          "The declared measurand value from measurand-specification. If the equation evaluates to a different scale " +
          "(e.g. model outputs a dimensionless fraction but measurand is in percent), the engine auto-scales all contributions and uc. " +
          "Pass this when the measurand value is known.",
      })),
      correlation_strategy: Type.Optional(Type.String({
        description:
          'How to combine uncertainty contributions within the propagate engine. ' +
          '"correlated" (default): algebraic sum of per-variable contributions within each source, then RSS across sources. ' +
          '"independent": each per-variable contribution RSS\'d individually (all pairs r=0).',
      })),
      correlation: Type.Optional(Type.String({
        description:
          "JSON array of correlation pairs for covariance terms. " +
          "Each: {var1, var2, r}. Adds 2·u_i·u_j·r to uc². " +
          "Example: '[{\"var1\":\"V\",\"var2\":\"V_factor\",\"r\":0.3}]'.",
      })),
    }),
    execute: async (_id, params: any) => {
      let point: Record<string, number>;
      let components: any[];
      try {
        point = JSON.parse(params.point);
        components = JSON.parse(params.components);
      } catch (e: any) {
        return {
          content: [
            { type: "text", text: `Invalid JSON input: ${e.message}` },
          ],
          details: { error: "invalid_json" },
        };
      }
      const engineArgs: Record<string, unknown> = {
        equation: params.equation,
        point,
        components,
      };
      if (params.measurand_value !== undefined) {
        engineArgs.measurand_value = params.measurand_value;
      }
      if (params.correlation_strategy !== undefined) {
        engineArgs.correlation_strategy = params.correlation_strategy;
      }
      if (params.correlation !== undefined) {
        try {
          engineArgs.correlation = JSON.parse(params.correlation);
        } catch {
          return {
            content: [{ type: "text", text: "correlation parameter must be valid JSON, e.g. '[{\"var1\":\"V\",\"var2\":\"V_factor\",\"r\":0.3}]'" }],
            details: { error: "invalid_correlation_json" },
          };
        }
      }
      const result: any = await callEngine("propagate", engineArgs);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Propagation failed: ${result.error}` }],
          details: result,
        };
      }
      // Format a readable summary
      const contribLines = result.components
        .map(
          (c: any) =>
            `  ${c.name}: u_eff=${c.u_eff} (${c.percent_of_uc2}% of u_c²)`,
        )
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `Combined u_c = ${result.combined_standard_uncertainty} ` +
              `(rel: ${result.relative_standard_uncertainty})\n` +
              `effective_dof = ${result.effective_dof ?? "∞"}\n` +
              `Contributions:\n${contribLines}`,
          },
        ],
        details: result,
      };
    },
  };
}

// ---- Tool: coverage_factor ----

export function makeCoverageFactorTool(): AgentTool {
  return {
    name: "coverage_factor",
    label: "Coverage Factor",
    description:
      "Convert effective degrees of freedom to the coverage factor k for a given confidence level (default 0.95). " +
      "Uses the t-distribution table. Returns k ≈ 1.96 for infinite dof. " +
      "Use this in synthesis-and-reporting to determine the correct expansion factor instead of assuming k=2.",
    parameters: Type.Object({
      dof: Type.Number({
        description:
          "Effective degrees of freedom (from propagate output). Use a large number for infinite dof.",
      }),
      confidence: Type.Optional(
        Type.Number({
          description: "Confidence level (default: 0.95).",
        }),
      ),
    }),
    execute: async (_id, params: any) => {
      const result: any = await callEngine("coverage_factor", {
        dof: params.dof,
        confidence: params.confidence ?? 0.95,
      });
      if (!result.ok) {
        return {
          content: [
            { type: "text", text: `Coverage factor failed: ${result.error}` },
          ],
          details: result,
        };
      }
      const hint = (params.dof >= 100 && (params.confidence ?? 0.95) === 0.95)
        ? `\n\n💡 ν_eff = ${params.dof} ≥ 100，t 分布已充分近似正态。行业惯例取 k = 2（约 95% 包含概率）。若使用 k = 2，请在报告中注明 "因有效自由度充分大，取 k = 2"。`
        : "";
      return {
        content: [
          {
            type: "text",
            text:
              `k = ${result.k} (dof=${result.dof}, confidence=${result.confidence})${hint}`,
          },
        ],
        details: result,
      };
    },
  };
}

// ---- Tool: calculate / evaluate (fallback) ----

async function evaluateExpression(params: any): Promise<AgentToolResult<unknown>> {
  let variables: Record<string, number> | undefined;
  if (params.variables) {
    try {
      variables = typeof params.variables === "string" ? JSON.parse(params.variables) : params.variables;
    } catch {
      return {
        content: [
          { type: "text", text: `Invalid JSON for variables: ${params.variables}` },
        ],
        details: { error: "invalid_json" },
      };
    }
  }
  const result: any = await callEngine("evaluate", {
    expression: params.expression,
    variables,
  });
  if (!result.ok) {
    return {
      content: [
        { type: "text", text: `Evaluation failed: ${result.error}` },
      ],
      details: result,
    };
  }
  return {
    content: [{ type: "text", text: String(result.value) }],
    details: result,
  };
}

export function makeCalculateTool(): AgentTool {
  return {
    name: "calculate",
    label: "Calculate",
    description:
      "Evaluate a mathematical expression using the SymPy-backed Python engine. " +
      "Use this for symbolic/numeric calculation, formula verification, unit conversion arithmetic, and expressions such as standard uncertainty conversions. " +
      "Supports SymPy syntax including +, -, *, /, **, sqrt, abs, log10, sin, cos, exp. " +
      "For variables, pass variables as a JSON object string.",
    parameters: Type.Object({
      expression: Type.String({
        description:
          "Mathematical expression, e.g. '0.08 / sqrt(3)' or 'x**2 + sqrt(y)'.",
      }),
      variables: Type.Optional(
        Type.String({
          description:
            "Optional JSON object of variable name → value, e.g. '{\"x\":3,\"y\":16}'.",
        }),
      ),
    }),
    execute: async (_id, params: any) => evaluateExpression(params),
  };
}

export function makeEvaluateTool(): AgentTool {
  return {
    name: "evaluate",
    label: "Evaluate Expression",
    description:
      "Evaluate a mathematical expression to a numeric result using sympy. " +
      "PREFER using specialized tools instead:\n" +
      "- For uncertainty propagation → use propagate\n" +
      "- For partial derivatives → use compute_sensitivity\n" +
      "- For statistics (mean, std, RSD) → use statistics\n" +
      "- For coverage factor → use coverage_factor\n\n" +
      "Use evaluate ONLY when your computation does not fit any of the above. " +
      "Example valid uses: converting a tolerance to standard uncertainty (u = a/√3), " +
      "verifying an intermediate value, unit conversion arithmetic. " +
      "DO NOT use evaluate for simple arithmetic (e.g., 1 + 1). " +
      "DO NOT chain evaluate calls to manually perform uncertainty propagation — use propagate.",
    parameters: Type.Object({
      expression: Type.String({
        description:
          "Mathematical expression, e.g. '0.08 / sqrt(3)'. Supports: +, -, *, /, **, sqrt, abs, log10, sin, cos, exp.",
      }),
      variables: Type.Optional(
        Type.String({
          description:
            "Optional JSON object of variable name → value, e.g. '{\"a\":0.08,\"b\":3}'.",
        }),
      ),
    }),
    execute: async (_id, params: any) => evaluateExpression(params),
  };
}
