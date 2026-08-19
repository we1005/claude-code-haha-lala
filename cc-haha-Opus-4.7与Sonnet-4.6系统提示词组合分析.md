# cc-haha Opus 4.7 与 Sonnet 4.6 系统提示词组合分析

## 1. 分析范围

本文分析当前工作树中以下问题：

1. Opus 4.7 和 Sonnet 4.6 是否各自维护一份完整系统提示词。
2. 两个模型共用的提示词位于哪里。
3. 模型差异通过什么代码注入。
4. system prompt、模型 ID 和工具 Schema 在 API 请求中如何组合。
5. 会话中切换模型后，模型相关提示词是否会同步更新。

主要代码路径：

```text
src/constants/prompts.ts
src/constants/system.ts
src/constants/systemPromptSections.ts
src/utils/systemPrompt.ts
src/utils/api.ts
src/utils/model/model.ts
src/services/api/claude.ts
src/screens/REPL.tsx
src/commands/model/model.tsx
```

本文基于 2026-07-23 的当前工作树。`src/constants/prompts.ts` 已有用户未提交修改：
原有 cyber risk instruction 被移除，并增加了 `getSecurityFilterSection()`。该修改属于
当前实际提示词的一部分，本文不会还原或评价其内容。

## 2. 核心结论

当前项目没有分别维护：

```text
opus47SystemPrompt
sonnet46SystemPrompt
```

也没有 Opus 4.7 和 Sonnet 4.6 各一份完整 Markdown 或字符串模板。

两个模型都调用同一个构造函数：

```ts
getSystemPrompt(tools, model, additionalWorkingDirectories, mcpClients)
```

位置：

```text
src/constants/prompts.ts:458
```

绝大部分提示词完全共用。新会话、相同配置和相同工具池下，真正随模型变化的主要是
`# Environment` 中的：

- 模型营销名称。
- 精确 model ID。
- knowledge cutoff。

此外，`Function Result Clearing` 可能根据远程配置中的模型支持列表出现或消失，但
当前构建中 Opus 4.7 和 Sonnet 4.6 都没有生成这一段。

## 3. 默认提示词的总体构造

`getSystemPrompt()` 返回的不是单个大字符串，而是 `string[]`。每个数组元素代表一个
逻辑 prompt block。

正常路径的组装位于：

```text
src/constants/prompts.ts:572-588
```

结构可以概括为：

```text
静态公共部分
  getSimpleIntroSection()
  getSimpleSystemSection()
  getSimpleDoingTasksSection()
  getActionsSection()
  getUsingYourToolsSection()
  getSimpleToneAndStyleSection()
  getOutputEfficiencySection()

SYSTEM_PROMPT_DYNAMIC_BOUNDARY

动态部分
  Session-specific guidance
  Memory
  Anthropic internal model override
  Environment
  Language
  Output style
  MCP instructions
  Scratchpad
  Function Result Clearing
  Tool-result summarization
  其他 feature-gated 段
```

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 只是提示词缓存边界，不会作为普通指令发送给模型。
API 组装阶段会识别并移除这个标记。

## 4. 静态公共部分

### 4.1 Intro

位置：

```text
src/constants/prompts.ts:190-198
```

职责包括：

- 将模型定义为软件工程交互式 agent。
- 告知模型可以使用当前工具。
- 限制无依据生成 URL。

这里没有 Opus/Sonnet 分支。

### 4.2 System

位置：

```text
src/constants/prompts.ts:200-211
```

职责包括：

- 终端文本输出格式。
- 工具权限和用户拒绝后的行为。
- `<system-reminder>` 等系统标签。
- 外部工具结果中的 prompt injection 风险。
- Hooks。
- 自动上下文压缩。

当前工作树的 `getSecurityFilterSection()` 在这里被追加，因此它会进入所有使用默认
prompt 的模型，包括 Opus 4.7、Sonnet 4.6 和其他模型。

### 4.3 Doing tasks

位置：

```text
src/constants/prompts.ts:213-267
```

职责包括：

- 软件工程任务解释。
- 先读代码再修改。
- 控制改动范围。
- 避免过度抽象。
- 处理失败、验证结果和用户反馈。

这里的条件主要是 `USER_TYPE` 和 feature flag，不是 Opus/Sonnet 分支。

### 4.4 Actions

位置：

```text
src/constants/prompts.ts:269-280
```

职责是区分本地可逆操作和需要确认的高风险操作。两个模型共用。

### 4.5 Using your tools

位置：

```text
src/constants/prompts.ts:283-328
```

该段根据实际启用的工具名称生成，例如：

- Read、Edit、Write。
- Glob、Grep。
- Bash。
- TodoWrite 或 TaskCreate。

因此它会随工具池变化，但在相同工具池下不会因为 Opus 4.7 或 Sonnet 4.6 而变化。

### 4.6 Tone、Style 和 Output efficiency

位置：

```text
src/constants/prompts.ts:416-455
```

这些段主要根据 `USER_TYPE` 和输出风格配置变化，不按 Opus/Sonnet 分开。

## 5. 动态公共部分

动态段在以下位置注册：

```text
src/constants/prompts.ts:503-567
```

它们通过 `systemPromptSection(name, compute)` 计算并缓存。

### 5.1 Session-specific guidance

根据当前工具和会话模式生成：

- 是否有 AskUserQuestion。
- 是否为交互式终端。
- 是否支持 Agent/subagent。
- 是否有 Skills。
- 是否有 Tool Search。

它与会话能力有关，不直接与 Opus/Sonnet 有关。

### 5.2 Memory

通过 `loadMemoryPrompt()` 加载。它取决于项目、用户配置和会话状态，而不是模型型号。

### 5.3 Language 和 Output style

从 settings 读取，两个模型共用。

### 5.4 MCP instructions

根据连接成功的 MCP server 动态生成。相同 MCP 状态下两个模型一致。

### 5.5 Scratchpad

根据当前 session 的 scratchpad 路径生成，与模型无关。

### 5.6 Tool-result summarization

公共指令：

```text
When working with tool results, write down any important information...
```

两个模型共用。

## 6. Opus 4.7 与 Sonnet 4.6 的文本差异

### 6.1 Environment 模型描述

模型相关描述在：

```text
src/constants/prompts.ts:663-721
```

`computeSimpleEnvInfo(modelId)` 调用：

```ts
getMarketingNameForModel(modelId)
getKnowledgeCutoff(modelId)
```

营销名称映射位于：

```text
src/utils/model/model.ts:601-635
```

知识截止时间位于：

```text
src/constants/prompts.ts:724-741
```

Opus 4.7 生成：

```text
You are powered by the model named Opus 4.7.
The exact model ID is claude-opus-4-7.
Assistant knowledge cutoff is May 2025.
```

Sonnet 4.6 生成：

```text
You are powered by the model named Sonnet 4.6.
The exact model ID is claude-sonnet-4-6.
Assistant knowledge cutoff is August 2025.
```

`Environment` 中其余内容仍然相同，例如：

- 工作目录。
- Git 状态。
- Platform、Shell 和 OS。
- 当前 Claude 模型家族列表。
- Claude Code 产品入口说明。
- Fast mode 说明。

### 6.2 Function Result Clearing

位置：

```text
src/constants/prompts.ts:833-851
```

这一段只有在以下条件同时满足时才出现：

1. 构建包含 `CACHED_MICROCOMPACT`。
2. 远程配置启用该功能。
3. `systemPromptSuggestSummaries` 启用。
4. 当前 model ID 匹配 `supportedModels`。

因此它是一个潜在的模型差异段，但不是独立的 Opus/Sonnet prompt 模板。

### 6.3 其他模型差异不一定属于 system prompt

项目中还有以下模型能力差异：

- context window。
- thinking 和 effort。
- fast mode。
- structured outputs。
- Tool Search 和 `tool_reference`。
- beta headers。
- Advisor 能力。
- 最大输出 token。

这些通常体现在 API 参数、工具过滤或运行时能力判断中，不应误认为是系统提示词正文
的差异。

真正决定请求使用哪个模型的是 API 请求中的 `model` 字段，而不是
`Environment` 中那句模型自我描述。

## 7. 实际渲染对比

使用当前工作树、当前 settings 和相同的 24 个基础工具，分别在清空
system-prompt section cache 后渲染：

```ts
getSystemPrompt(tools, 'claude-opus-4-7')
getSystemPrompt(tools, 'claude-sonnet-4-6')
```

结果：

| 项目 | Opus 4.7 | Sonnet 4.6 |
| --- | ---: | ---: |
| 基础工具数量 | 24 | 24 |
| Prompt block 数量 | 12 | 12 |
| 拼接后字符数 | 26,313 | 26,320 |
| 不同 block 数量 | 1 | 1 |

唯一不同的 block 是 `# Environment`，差异为模型名称、model ID 和 knowledge
cutoff。

因此可以确定：当前外部构建不是“公共 prompt + 一大段 Opus 专属 prompt”和
“公共 prompt + 一大段 Sonnet 专属 prompt”，而是“一套公共 prompt + 很小的
模型元信息差异”。

## 8. 从 REPL 到 API 的组合过程

### 8.1 REPL 生成默认 prompt

REPL 在每次请求前调用：

```text
src/screens/REPL.tsx:2769-2773
```

核心调用：

```ts
getSystemPrompt(freshTools, mainLoopModelParam, additionalDirectories, mcpClients)
```

### 8.2 选择默认、自定义或 Agent prompt

之后调用：

```text
src/utils/systemPrompt.ts:41-122
```

普通情况下的优先级为：

```text
override prompt
coordinator prompt
agent prompt
custom system prompt
default system prompt
```

`appendSystemPrompt` 会追加在最终选择结果后面。

这意味着 `--system-prompt-file` 对应的 custom prompt 会替换
`getSystemPrompt()` 生成的默认正文，而不是按模型与其做智能合并。

### 8.3 API 添加 Claude Code 公共身份

Claude Code 身份前缀定义于：

```text
src/constants/system.ts:10
```

内容是：

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

API 请求构造在以下位置将其加到 prompt 前面：

```text
src/services/api/claude.ts:1408-1418
```

顺序是：

```text
Attribution header
Claude Code / Agent SDK identity prefix
buildEffectiveSystemPrompt() 的结果
可选 Advisor instructions
可选 Chrome tool-search instructions
```

这个身份前缀同样不是 Opus 4.7 或 Sonnet 4.6 专属。

### 8.4 缓存块拆分

`splitSysPromptPrefix()` 根据 attribution、identity prefix 和
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 把 prompt 拆成可缓存块：

```text
src/utils/api.ts:321-435
```

第一方 global cache 模式下通常为：

```text
Attribution                         不缓存
Claude Code identity prefix         不缓存
静态公共 prompt                     global cache
动态 session prompt                 不使用 global cache
```

这只是 API prompt caching 策略，不会创建不同模型的独立提示词。

### 8.5 最终 API 请求

最终请求位于：

```text
src/services/api/claude.ts:1764-1788
```

结构可简化为：

```ts
{
  model: normalizeModelStringForAPI(options.model),
  messages,
  system,
  tools: allTools,
  max_tokens,
  thinking,
  betas
}
```

其中：

- `model` 决定实际调用 Opus 4.7 还是 Sonnet 4.6。
- `system` 是上述公共提示词和动态段。
- `tools` 是真实注册的结构化工具。

## 9. 工具说明与 system prompt 的边界

工具 Schema 并不直接拼进 `getSystemPrompt()` 的主体。

工具 Schema 在：

```text
src/services/api/claude.ts:1281-1296
```

通过 `toolToAPISchema()` 生成，包括：

- `name`
- `description`
- `input_schema`
- 可选 `strict`
- 可选 `defer_loading`

最终通过独立的 `tools` 字段发送：

```text
src/services/api/claude.ts:1775-1776
```

`getUsingYourToolsSection()` 只是告诉模型如何选择这些工具，不等于工具 Schema
本身。

对于 Opus 4.7 和 Sonnet 4.6：

- 相同会话通常从相同基础工具池开始。
- 两者都在当前代码的 structured-output 支持列表中。
- Tool Search、MCP 延迟加载和其他能力仍可能根据模型及 provider 做过滤。

因此“工具池可能不同”属于 API 运行时能力差异，不代表存在两份完整系统提示词。

## 10. 模型切换后的缓存一致性问题

### 10.1 缓存机制

动态段通过固定名称缓存：

```ts
systemPromptSection('env_info_simple', () =>
  computeSimpleEnvInfo(model, additionalWorkingDirectories),
)

systemPromptSection('frc', () =>
  getFunctionResultClearingSection(model),
)
```

`systemPromptSection()` 的说明是：每个 section 只计算一次，直到 `/clear` 或
`/compact`：

```text
src/constants/systemPromptSections.ts:16-67
```

缓存 key 是：

```text
env_info_simple
frc
```

其中没有包含 model ID。

### 10.2 `/model` 不清理该缓存

模型选择代码只更新：

```ts
mainLoopModel: model
mainLoopModelForSession: null
```

位置：

```text
src/commands/model/model.tsx:47-57
```

此路径没有调用 `clearSystemPromptSections()`。

### 10.3 实际复现

在同一个进程中执行：

```text
1. getSystemPrompt([], 'claude-opus-4-7')
2. 不清理 section cache
3. getSystemPrompt([], 'claude-sonnet-4-6')
```

结果：

```json
{
  "differingBlocksWithoutCacheClear": [],
  "sonnetEnvAfterOpus": [
    "You are powered by the model named Opus 4.7...",
    "Assistant knowledge cutoff is May 2025."
  ]
}
```

即第二次已经要求构建 Sonnet 4.6 prompt，但 `Environment` 仍复用了首次生成的
Opus 4.7 内容。

### 10.4 实际影响

这不会把真实 API 模型改回 Opus 4.7。请求中的 `model` 字段仍然由最新
`mainLoopModel` 决定，所以服务端实际调用的可以是 Sonnet 4.6。

影响是模型收到的 system prompt 自我描述可能过期：

- 实际运行 Sonnet 4.6，却被告知自己是 Opus 4.7。
- knowledge cutoff 仍显示 May 2025，而不是 August 2025。
- 如果 FRC 的支持范围在两模型间不同，`frc` 段也可能沿用旧模型结果。

这是提示词缓存与模型切换之间的状态一致性问题。

### 10.5 可选修复方向

如果后续需要修复，较明确的选择是让模型相关 section 的缓存 key 包含 canonical
model ID，例如：

```text
env_info_simple:claude-opus-4-7
env_info_simple:claude-sonnet-4-6
frc:claude-opus-4-7
frc:claude-sonnet-4-6
```

另一种方式是在所有模型切换入口调用 `clearSystemPromptSections()`。后者实现直观，
但需要覆盖 `/model`、快捷模型选择、fast mode、plan-mode session override 等所有
切换路径，并会主动破坏当前 prompt cache。

本文只记录问题，没有修改运行时代码。

## 11. `--system-prompt-file` 对上述结构的影响

`buildEffectiveSystemPrompt()` 的普通分支为：

```ts
agentSystemPrompt
  ? [agentSystemPrompt]
  : customSystemPrompt
    ? [customSystemPrompt]
    : defaultSystemPrompt
```

因此使用：

```bash
claude --system-prompt-file "/path/to/custom.md"
```

会替换 `getSystemPrompt()` 生成的整套默认正文，包括：

- 静态公共部分。
- 默认 Session guidance。
- 默认 Memory mechanics。
- 默认 Environment。
- 默认模型名称、model ID 和 knowledge cutoff。
- 默认 Language、Output style、MCP 和 Scratchpad 段。

API 层仍会在 custom prompt 前添加 Claude Code identity prefix，并通过独立字段发送
真实 `model` 和 `tools`。

所以 custom system prompt 文件本身不会选择或解锁 Opus 4.7、Sonnet 4.6 或其他
模型。实际模型仍由请求的 `model` 字段以及 provider/OAuth 服务端权限决定。

## 12. 最终回答

针对“Opus 4.7 与 Sonnet 4.6 的提示词是否分开”的准确回答是：

```text
完整提示词模板：没有分开
静态公共正文：同一套
动态会话正文：绝大部分同一套
新会话模型差异：Environment 中的名称、ID、knowledge cutoff
可选模型差异：Function Result Clearing 等 feature/config 段
真正模型选择：API request.model
工具定义：API request.tools，独立于 system prompt
```

当前代码还存在一个相关事实：会话中切换模型不会主动清理
`env_info_simple`/`frc` section cache，所以模型自我描述可能继续显示切换前的模型，
直到相关缓存被清理。
