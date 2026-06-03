# Contract — Uncertainty Agent

> 由 `config/workflow.json` 自动生成。重新生成：`bun run scripts/generate-contract-md.ts`

## 概述

每个 SubAgent 通过 `finishWork` 提交 JSON。`finishWork` 根据配置的 JSON Schema 校验，通过后写入 `context.json` 并推进到下一个 stage。

## 四步 SubAgent

### 1. 明确被测量

**Stage ID：** `measurand-specification`

**输入：** 输入材料 Markdown

#### 明确被测量

**写入 context 字段：** `measurand_specification`

**JSON Schema：** `config/schemas/four-phase/01-measurand-and-measurement-information.schema.json`

### 2. 建立测量模型

**Stage ID：** `measurement-model`

**输入：** 输入材料 Markdown, `measurand_specification`

#### 建立测量模型

**写入 context 字段：** `measurement_model`

**JSON Schema：** `config/schemas/four-phase/02-measurement-model.schema.json`

### 3. 识别并量化不确定度来源

**Stage ID：** `uncertainty-components`

**输入：** 输入材料 Markdown, `measurement_model`

#### 识别并量化不确定度来源

**写入 context 字段：** `uncertainty_components`

**JSON Schema：** `config/schemas/four-phase/03-uncertainty-sources-and-quantification.schema.json`

### 4. 计算合成与扩展不确定度

**Stage ID：** `synthesis-and-reporting`

**输入：** `uncertainty_components`

#### 计算合成与扩展不确定度

**写入 context 字段：** `synthesis_and_reporting`

**JSON Schema：** `config/schemas/four-phase/04-synthesis-expansion-and-report.schema.json`

## Invariant checks

当前未配置额外 invariant check。
