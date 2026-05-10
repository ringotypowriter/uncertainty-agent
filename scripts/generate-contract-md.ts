/**
 * Generate CONTRACT.md from config/workflow.json.
 * Run: bun run scripts/generate-contract-md.ts
 */
import { INVARIANTS } from "../src/contract";
import { getStageContextFields, getStageWorkItems, loadWorkflowConfig } from "../src/workflow-config";

async function generate(): Promise<string> {
  const workflow = await loadWorkflowConfig(process.cwd());
  const stageInputs = new Map<string, string[]>();
  let previousOutput: string | undefined;
  for (const stage of workflow.stages) {
    stageInputs.set(stage.id, stage.inputContextField ? [stage.inputContextField] : previousOutput ? [previousOutput] : []);
    const outputs = getStageContextFields(stage);
    previousOutput = outputs[outputs.length - 1];
  }

  let md = `# Contract — Uncertainty Agent\n\n`;
  md += `> 由 \`config/workflow.json\` 自动生成。重新生成：\`bun run scripts/generate-contract-md.ts\`\n\n`;
  md += `## 概述\n\n`;
  md += `每个 SubAgent 通过 \`finishWork\` 提交 JSON。\`finishWork\` 根据配置的 JSON Schema 校验，通过后写入 \`context.json\` 并推进 checkpoint 或 stage。\n\n`;

  md += `## SubAgent 与 checkpoint\n\n`;
  for (let i = 0; i < workflow.stages.length; i++) {
    const stage = workflow.stages[i];
    const inputs = stageInputs.get(stage.id) ?? [];
    md += `### ${i + 1}. ${stage.title}\n\n`;
    md += `**Stage ID：** \`${stage.id}\`\n\n`;
    md += `**输入：** ${stage.paperContext ? "输入材料 Markdown" : inputs.length ? inputs.map((field) => `\`${field}\``).join(", ") : "无"}\n\n`;
    if (stage.systemPrompt) md += `**System prompt：** ${stage.systemPrompt}\n\n`;

    for (const item of getStageWorkItems(stage)) {
      md += `#### ${item.title}\n\n`;
      md += `**写入 context 字段：** \`${item.contextField}\`\n\n`;
      md += `**JSON Schema：** \`${item.schemaPath}\`\n\n`;
    }
  }

  md += `## Invariant checks\n\n`;
  if (INVARIANTS.length === 0) {
    md += `当前未配置额外 invariant check。\n`;
  } else {
    md += `| ID | Stage | 类型 | 描述 |\n|----|-------|------|------|\n`;
    for (const inv of INVARIANTS) {
      md += `| \`${inv.id}\` | ${inv.stage} | ${inv.type} | ${inv.description} |\n`;
    }
  }

  return md;
}

const outPath = new URL("../CONTRACT.md", import.meta.url).pathname;
Bun.write(outPath, await generate());
console.log(`✅ Generated ${outPath}`);
