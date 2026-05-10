import { formatWorkItemPrompt, getStageWorkItems } from "../workflow-config.js";
import type { WorkflowStage } from "../workflow-config.js";

export function buildStagePrompt(stage: WorkflowStage, workItemIndex: number): string {
  const workItem = getStageWorkItems(stage)[workItemIndex];
  if (!workItem) return stage.prompt;
  return [
    stage.prompt.trim(),
    "",
    "---",
    "",
    formatWorkItemPrompt(workItem),
  ].join("\n");
}
