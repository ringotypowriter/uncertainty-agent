import { describe, expect, test } from "bun:test";
import http from "node:http";
import { checkInvariants, validateStageOutput } from "../src/contract.js";
import { runReferenceSearch } from "../src/tools/general-tools.js";

describe("JSON schema contract", () => {
  const schema = {
    type: "object",
    required: ["result", "records"],
    properties: {
      result: { type: "object" },
      records: { type: "array", minItems: 1 },
    },
    additionalProperties: false,
  };

  test("accepts data matching the configured schema", () => {
    const result = validateStageOutput("stage-test", { result: {}, records: ["calculation"] }, {}, { schema });
    expect(result.violations).toEqual([]);
  });

  test("reports schema violations", () => {
    const result = validateStageOutput("stage-test", { result: [], records: [], extra: true }, {}, { schema });
    expect(result.violations.map((v) => v.path)).toContain("/result");
    expect(result.violations.map((v) => v.path)).toContain("/records");
    expect(result.violations.map((v) => v.path)).toContain("/extra");
  });

  test("rejects work items without a schema", () => {
    const result = validateStageOutput("stage-test", { result: {} }, {}, {});
    expect(result.violations.map((v) => v.path)).toContain("/");
  });
});

describe("invariant hook", () => {
  test("returns empty results when no invariant checks are configured", () => {
    expect(checkInvariants("uncertainty-components", {}, {})).toEqual({ errors: [], warnings: [] });
  });
});

describe("reference search", () => {
  test("posts StandardRAG query-tree payload and summarizes hits", async () => {
    let received: { path?: string; body?: any } = {};
    const server = http.createServer((req, res) => {
      received.path = req.url;
      let raw = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received.body = JSON.parse(raw);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          hits: [{ text: "standard block", score: 0.9 }],
          expanded_question: "expanded",
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const result = await runReferenceSearch(`http://127.0.0.1:${address.port}/query-tree`, {
        query: "如何评定校准曲线引入的标准不确定度？",
        limit: 3,
      }) as any;
      expect(received.path).toBe("/query-tree");
      expect(received.body).toEqual({
        question: "如何评定校准曲线引入的标准不确定度？",
        top_k: 3,
      });
      expect(result.summary.hits).toBe(1);
      expect(result.data.hits[0].text).toBe("standard block");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
