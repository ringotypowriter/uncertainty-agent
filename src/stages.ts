import type { AgentOptions } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { WorkflowConfig, WorkflowStage } from "./workflow-config.js";

export type StageId = string;

export interface StageConfig {
  id: StageId;
  name: string;
  description: string;
  workflowStage: WorkflowStage;
  model?: Model<any>;
  systemPrompt?: string;
  agentOptions?: Omit<AgentOptions, "initialState">;
}

export interface UncertaintyContext {
  [field: string]: any;
  measurand_specification?: any;
  measurement_model?: any;
  uncertainty_components?: any;
  synthesis_and_reporting?: any;
}

export interface PipelineContext {
  workDir: string;
  workflow: WorkflowConfig;
  inputCwd: string;
  inputDir: string;
  outputDir: string;
  contextPath: string;
  feedbackPath: string;
  referenceQueryUrl: string;
  currentStage: StageId | null;
  completedStages: StageId[];
  markdownInputPath?: string;
}
