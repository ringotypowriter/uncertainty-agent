import type { StageConfig } from "../stages.js";
import type { WorkflowConfig } from "../workflow-config.js";

export function createStageConfigs(workflow: WorkflowConfig): StageConfig[] {
  return workflow.stages.map((stage) => ({
    id: stage.id,
    name: stage.title,
    description: "Execute the configured workflow stage.",
    workflowStage: stage,
    systemPrompt: stage.systemPrompt,
  }));
}
