import { describe, expect, test } from "bun:test";
import { makeCalculateTool } from "../src/tools/sympy-tools.js";

describe("calculate tool", () => {
  test("evaluates symbolic expressions with variables through SymPy", async () => {
    const tool = makeCalculateTool();
    const result = await tool.execute("calculate-test", {
      expression: "x**2 + sqrt(y)",
      variables: '{"x":3,"y":16}',
    }) as any;

    expect(result.details?.ok).toBe(true);
    expect(result.details?.value).toBe(13);
    expect(result.content?.[0]?.text).toBe("13");
  });
});
