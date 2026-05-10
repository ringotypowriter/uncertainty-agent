# Contract — Uncertainty Agent

> 由 `config/workflow.json` 自动生成。重新生成：`bun run scripts/generate-contract-md.ts`

## 概述

每个 SubAgent 通过 `finishWork` 提交 JSON。`finishWork` 根据配置的 JSON Schema 校验，通过后写入 `context.json` 并推进 checkpoint 或 stage。

## SubAgent 与 checkpoint

### 1. 明确被测量、建立测量模型、识别不确定度来源

**Stage ID：** `stage-123`

**输入：** 输入材料 Markdown

**System prompt：** 你是测量不确定度评定 SubAgent，负责 stage-123。输入材料为描述化学测量实验的文本；按当前 checkpoint 任务完成输出，finishWork 通过当前 JSON Schema 校验后返回下一步任务。依据范围：输入材料、当前 prompt 中已完成 checkpoint 产物、search_reference 检索依据、calculate 计算结果。每个 checkpoint 完成时调用 finishWork 提交符合当前 JSON Schema 的 JSON。

#### Checkpoint 1 — 明确被测量

**写入 context 字段：** `stage1_measurand`

**JSON Schema：** `config/schemas/checkpoint-1-measurand.schema.json`

#### Checkpoint 2 — 建立测量模型

**写入 context 字段：** `stage2_measurement_model`

**JSON Schema：** `config/schemas/checkpoint-2-measurement-model.schema.json`

#### Checkpoint 3 — 识别不确定度来源

**写入 context 字段：** `stage3_uncertainty_sources`

**JSON Schema：** `config/schemas/checkpoint-3-uncertainty-sources.schema.json`

### 2. 量化

**Stage ID：** `stage-4`

**输入：** 输入材料 Markdown

**System prompt：** 你是测量不确定度量化 SubAgent，负责 stage-4。输入为 checkpoint 3 的不确定度来源产物。依据范围：当前 prompt 提供的输入产物、search_reference 检索依据、calculate 计算结果。完成时调用 finishWork 提交符合 JSON Schema 的 JSON。

#### 量化

**写入 context 字段：** `stage4_quantification`

**JSON Schema：** `config/schemas/stage-4-quantification.schema.json`

### 3. 合成与扩展

**Stage ID：** `stage-5`

**输入：** `stage4_quantification`

**System prompt：** 你是测量不确定度合成与扩展 SubAgent，负责 stage-5。输入为 stage-4 的量化产物。依据范围：当前 prompt 提供的输入产物、search_reference 检索依据、calculate 计算结果。完成时调用 finishWork 提交符合 JSON Schema 的 JSON。

#### 合成与扩展

**写入 context 字段：** `stage5_synthesis_expanded`

**JSON Schema：** `config/schemas/stage-5-synthesis-expanded.schema.json`

### 4. 报告与生成制品

**Stage ID：** `stage-6`

**输入：** `stage5_synthesis_expanded`

**System prompt：** 你是测量不确定度报告与制品 SubAgent，负责 stage-6。输入为 stage-5 的合成与扩展产物。依据范围：当前 prompt 提供的输入产物、search_reference 检索依据、calculate 计算结果。完成时调用 finishWork 提交符合 JSON Schema 的 JSON。

#### 报告与生成制品

**写入 context 字段：** `stage6_report_artifacts`

**JSON Schema：** `config/schemas/stage-6-report-artifacts.schema.json`

## Invariant checks

当前未配置额外 invariant check。
