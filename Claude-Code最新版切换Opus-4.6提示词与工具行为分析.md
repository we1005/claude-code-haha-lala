# Claude Code 最新版切换 Opus 4.6 时的提示词与工具行为分析

> 分析日期：2026-07-26
> 本地项目：`/Volumes/zhitai-7100/personal/cc-haha`
> 分析范围：`provider/runtime`、`agent-loop`、系统提示词组装、工具 Schema、模型切换与 Git 历史
> 说明：本文中的 “Open 4.6/4.7” 均按上下文理解为 “Opus 4.6/4.7”。

## 一、核心结论

假如在最新版 Claude Code 中明确切换到 `claude-opus-4-6`，得到的并不是“当年只支持 Opus 4.6 的旧版 Claude Code”，也不是“最新版主体提示词完全不变，只更换了工具集”。

更准确的结构是：

```text
model    = 选中的固定模型快照，例如 claude-opus-4-6
system   = 当前 Claude Code 客户端根据模型、环境和功能开关组装的系统提示词
tools    = 当前客户端注册并发送的工具名称、描述和输入 Schema
messages = 会话历史、CLAUDE.md、hooks、动态附件、压缩摘要等上下文
runtime  = thinking、effort、context window、max tokens、beta headers 等模型能力配置
```

因此：

1. `claude-opus-4-6` 的模型权重不会因为使用最新版客户端而变成 Opus 4.7、4.8 或 5。
2. 系统提示词由客户端版本决定，但当前最新版还可能根据模型代际选择不同的主体提示词分支。
3. 工具集和工具 Schema 主要由当前客户端、权限、provider、feature flags 和插件决定，不会回退到 Opus 4.6 发布时的历史工具集。
4. 一些工具字段和运行时功能会根据模型 ID 再做能力过滤。
5. 所以“最新版客户端 + Opus 4.6”是一种混合组合：旧模型快照加最新版客户端 harness。

## 二、需要区分的四个层次

### 2.1 模型快照

Anthropic 官方说明，从 Claude 4.6 开始，无日期模型 ID 是固定模型快照：

```text
claude-opus-4-6
claude-opus-4-7
claude-opus-4-8
claude-opus-5
```

`claude-opus-4-6` 不是一个自动追随最新版 Opus 的 alias。只要 API 最终实际接受并执行这个 ID，底层模型就是固定的 Opus 4.6 快照。

官方也说明，固定权重之外的服务基础设施仍可能变化，例如：

- 请求路由
- 安全分类器
- 采样基础设施
- 服务端策略

因此同一模型 ID 在不同时期仍可能出现小幅行为差异，但那不代表模型权重被替换。

参考：

- [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)

### 2.2 Claude Code 系统提示词

系统提示词不是模型本身携带的固定文件，而是 Claude Code 客户端在请求前组装出来的 harness。

它通常包含：

- Claude Code 身份
- 工具使用规范
- 编码与修改规则
- Git 行为
- 权限和安全规则
- 沟通和输出风格
- 当前工作目录和操作系统
- Memory、Scratchpad、Session guidance
- MCP、Skills、CLAUDE.md 等动态上下文相关规则

官方 Agent SDK 文档也将 Claude Code 的完整 system prompt 称为 `claude_code` preset，并说明它包含工具使用、编码风格、回复语气、安全规则和环境上下文。

参考：

- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)

### 2.3 工具定义

Anthropic Messages API 中，工具不是简单地写在 Markdown system prompt 末尾。客户端通常通过独立的 `tools` 字段发送：

```text
name
description
input_schema
strict
defer_loading
eager_input_streaming
cache_control
```

工具的 `description` 和 `input_schema` 对模型具有提示作用，但它们在请求结构中与 `system` 是分开的。

### 2.4 运行时能力

即使两个模型收到相同主体提示词和工具列表，客户端仍可能根据模型 ID 调整：

- effort
- extended thinking
- adaptive thinking
- structured outputs
- strict tools
- fast mode
- 1M context
- advisor
- max output tokens
- prompt caching
- beta headers

所以“工具看起来一样”也不代表底层请求参数完全相同。

## 三、最新版 Claude Code 是否会因模型而更换主体提示词

答案是：**会，但不是为每个模型加载一份完全独立的历史提示词文件。**

截至分析日期，官方 Claude Code changelog 顶部版本为 2.1.220，2.1.219 已将默认 Opus 更新到 Opus 5。

更重要的是，Claude Code 2.1.154 的 changelog 明确写明：

> The lean system prompt is now the default for all models except Haiku, Sonnet, and Opus 4.7 and earlier.

这意味着当前客户端至少存在两类主体提示词路径：

1. 面向较新模型的 lean system prompt。
2. 为 Haiku、Sonnet、Opus 4.7 及更早模型保留的非 lean/legacy 路径。

因此在真正的最新版 Claude Code 中切换到 Opus 4.6：

- 不会使用新模型默认的 lean prompt。
- 会进入旧模型适配的非 lean/legacy prompt 路径。
- 但这仍然是最新版客户端当前维护的 legacy 路径。
- 它不等于 Opus 4.6 刚发布时旧客户端中的历史 prompt。

参考：

- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Model configuration](https://code.claude.com/docs/en/model-config)

## 四、三种组合的区别

| 运行组合 | 主体系统提示词 | 动态环境内容 | 工具与 Schema | 模型能力判断 |
| --- | --- | --- | --- | --- |
| 旧版 Claude Code + Opus 4.6 | 当时版本的旧 prompt | 当时版本格式 | 当时的工具 | 当时的能力逻辑 |
| 最新 Claude Code + Opus 4.6 | 最新客户端维护的 legacy prompt | 最新环境、Memory、会话机制 | 最新工具，经过权限/provider/feature 过滤 | 最新客户端对 4.6 的能力判断 |
| 最新 Claude Code + 最新模型 | 最新 lean prompt 或新模型专用路径 | 最新动态内容 | 最新工具 | 最新模型能力 |

所以使用最新版客户端运行 Opus 4.6，通常会相对于旧客户端获得：

- 新增或更新的工具
- 新工具的 description 和 input schema
- 更新后的权限、安全和 Git 规则
- 更新后的 Memory、Skills、MCP 和动态上下文机制
- 新的 prompt caching 和 context management 行为
- 更新后的 Agent、background task、worktree 或 workflow 规则
- 最新客户端维护的旧模型兼容提示词

但具体是否启用某个功能，还会受订阅、provider、组织策略、feature flags 和模型能力匹配影响。

## 五、本地 cc-haha 源码中的请求结构

### 5.1 `model`、`system`、`tools` 分开发送

本地源码最终构造 Anthropic 请求的位置：

- `src/services/api/claude.ts:1764`

核心结构为：

```ts
return {
  model: normalizeModelStringForAPI(options.model),
  messages: ...,
  system,
  tools: allTools,
  tool_choice: options.toolChoice,
  ...
}
```

这直接证明：

- 切换模型首先修改 `model` 字段。
- 系统提示词通过 `system` 字段独立发送。
- 工具 Schema 通过 `tools` 字段独立发送。

模型切换不会自动把整个客户端退回旧版本。

### 5.2 默认系统提示词的组装

默认 prompt 入口：

- `src/constants/prompts.ts:458`

`getSystemPrompt(tools, model, ...)` 接收工具和模型，然后组合静态与动态部分。

公共静态部分位于约 572-588 行，包括：

```text
Intro
System
Doing tasks
Actions
Using your tools
Tone and style
Output efficiency
```

动态部分位于约 503-567 行，包括：

```text
Session guidance
Memory
Environment
Language
Output style
MCP instructions
Scratchpad
Function result clearing
Tool result summarization
其他 feature-gated sections
```

模型参数会进入：

- `computeSimpleEnvInfo(model, ...)`
- `getFunctionResultClearingSection(model)`
- 其他模型能力判断

在这份源码中，模型不是直接对应一整份独立 Markdown prompt。

### 5.3 工具列表由客户端产生

基础工具列表：

- `src/tools.ts:194`

工具是否加入列表主要取决于：

- 当前客户端是否实现了该工具
- feature flags
- provider
- `USER_TYPE`
- permission mode
- worktree、team、MCP 等运行状态

并不是简单根据 `Opus 4.6` 或 `Opus 4.7` 切换一整套工具清单。

### 5.4 工具 Schema 的模型相关部分

工具转 API Schema 的入口：

- `src/utils/api.ts:119`

工具主体由当前客户端计算：

```ts
{
  name: tool.name,
  description: await tool.prompt(...),
  input_schema
}
```

模型 ID 在此主要影响能力字段。例如 `strict: true` 只有在当前模型支持 structured outputs 时才加入。

因此：

- 工具名称、description、input schema 通常来自最新版客户端。
- 某些高级字段是否启用由模型能力决定。

## 六、本地 Opus 4.6、Opus 4.7、Sonnet 4.6 的实际渲染结果

使用当前源码，在每次渲染前清除 system prompt section cache，分别渲染：

```text
claude-opus-4-6
claude-opus-4-7
claude-sonnet-4-6
```

当前默认 feature 状态下，三者都产生 12 个 system prompt block。

对比结果：

```text
Opus 4.6 vs Opus 4.7：只有 1 个 block 不同
Opus 4.7 vs Sonnet 4.6：只有 1 个 block 不同
```

不同的部分都是 `# Environment`。

这说明当前泄露版/cc-haha 架构中：

- 公共主体高度共享。
- 默认工具相关规则高度共享。
- 模型名称、精确 ID、知识截止日期等位于动态 Environment。
- feature flags 打开后，仍可能出现其他模型相关差异。

## 七、当前 cc-haha 强制指定 Opus 4.6 的异常

### 7.1 模型 ID会继续发送

模型解析入口：

- `src/utils/model/model.ts:477`

当前代码只对更老的 Opus 4.0 和 4.1 做 first-party legacy remap，没有把 `claude-opus-4-6` 列入 remap。

所以：

```text
--model claude-opus-4-6
```

在 cc-haha 本地解析阶段会保留该字符串，并最终作为 API `model` 字段发送。

这并不保证 provider 一定允许使用，但本地不会仅因为它是 4.6 就自动改成 4.7。

### 7.2 4.6 的专用 canonical mapping 已被删除

当前 canonical mapping：

- `src/utils/model/model.ts:239`

只专门识别：

```text
claude-opus-4-7
claude-opus-4-5
claude-opus-4-1
generic claude-opus-4
```

当前 marketing name：

- `src/utils/model/model.ts:602`

也没有专门的 `claude-opus-4-6` 分支。

因此强制指定 `claude-opus-4-6` 时，当前源码实际把它显示为泛化的：

```text
Opus 4
```

### 7.3 当前实际 Environment

当前源码渲染出的关键内容为：

```text
You are powered by the model named Opus 4.
The exact model ID is claude-opus-4-6.
Assistant knowledge cutoff is January 2025.
The most recent model family includes Opus 4.7.
Fast mode uses Opus 4.7.
```

这是一个混合状态：

- 实际请求模型 ID 是 `claude-opus-4-6`。
- 自我描述退化为泛化的 `Opus 4`。
- 知识截止日期退化为 generic Opus 4 的 January 2025。
- “最新模型”和 fast mode 说明仍指向 Opus 4.7。

### 7.4 旧版 4.6 基线原本的 Environment

Git 初始源码提交 `f5a40b86` 中，4.6 有专用映射：

```text
Claude Opus 4.6
claude-opus-4-6
knowledge cutoff: May 2025
latest model: Opus 4.6
fast mode: Opus 4.6
```

所以当前 cc-haha 强制运行 4.6 时，并不能完美复现旧版 4.6 客户端的自我描述与能力映射。

## 八、本仓库从 4.6 到 4.7 的 Git 历史说明

关键提交：

```text
f5a40b86  2026-03-31  init: add source code from src.zip
20806f40  2026-04-18  chore: update cluade model name
```

对比 `f5a40b86..HEAD` 的 `src/constants/prompts.ts`，排除当前工作区未提交的用户修改后，公共 prompt 主体没有发生实质变化。

主要变化只有：

- `FRONTIER_MODEL_NAME` 从 Opus 4.6 改为 Opus 4.7
- 默认 Opus ID 从 `claude-opus-4-6` 改为 `claude-opus-4-7`
- Environment 中“最新模型”文案从 4.6 改为 4.7
- 知识截止日期的专用判断从 4.6 改为 4.7
- 部分 canonical、marketing name、effort、fast mode 等模型映射同步改名

`20806f40` 涉及 45 个文件，但总体是 116 行替换为 116 行，主要属于模型 ID 和显示名称迁移。

它没有引入一套全新的 Opus 4.7 主体 prompt。

因此本仓库的“4.7 支持”更接近：

```text
4.6 时代源码 + 4.7 模型 ID/显示/能力映射适配
```

不能把这个提交当作官方 Claude Code 2.1.111 完整 Opus 4.7 客户端源码的等价实现。

## 九、客户端升级带来的工具变化

虽然本仓库从 4.6 到 4.7 的主体 prompt 几乎未变，但客户端工具仍在其他提交中继续演进。

确认到的例子包括：

### 9.1 新增 `CronUpdate`

`src/tools.ts` 中，feature `AGENT_TRIGGERS` 开启时新增：

```text
CronUpdate
```

它允许更新现有定时任务的：

- cron 表达式
- prompt
- name
- description
- folder
- model
- permission mode
- worktree
- recurring

### 9.2 `CronList` Schema 扩展

新增输出字段：

```text
name
description
folder
model
permissionMode
worktree
frequency
scheduledTime
```

### 9.3 `TaskStop` 说明改变

旧版说明较宽泛：

```text
需要终止长时间运行的任务时使用
```

新版限制为：

- 用户明确要求取消
- 任务明显 runaway、harmful、duplicative 或不再有价值
- 不要因为已经获得部分输出就提前终止后台 Agent

### 9.4 Agent 后台任务说明改变

新版 Agent tool result 增加了不要过早停止后台 Agent 的 guidance，并修改了后台完成通知和清理顺序。

这些变化会影响模型如何使用工具，即使主体系统提示词没有变化。

## 十、同一会话 `/model` 切换的缓存问题

本项目通过 `systemPromptSection()` 缓存动态段：

- `src/constants/systemPromptSections.ts:17`

注释明确说明：

```text
Computed once, cached until /clear or /compact.
```

Environment 的缓存键为：

```text
env_info_simple
```

这个 key 本身不包含 model ID。

本地实际验证：

1. 清空 prompt section cache。
2. 先渲染 Opus 4.7。
3. 不清缓存，直接渲染 Opus 4.6。
4. 两次得到的 12 个 prompt block 完全一致。
5. 第二次 Environment 仍然写着 Opus 4.7。

结果：

```json
{
  "blocksA": 12,
  "blocksB": 12,
  "differentBlocks": 0,
  "identical": true
}
```

但最终 API 请求中的 `model` 字段是独立的，所以可能出现：

```text
实际请求：claude-opus-4-6
系统自我描述：claude-opus-4-7
```

这意味着不能通过问模型“你是什么模型”判断实际调用模型。

公开 issue 也有人报告类似现象：`/model` 已显示切换为 Opus 4.6，但 system metadata 仍显示之前的 Sonnet 4.6。

参考：

- [anthropics/claude-code#36835](https://github.com/anthropics/claude-code/issues/36835)

需要注意的是，官方当前文档说明，最新版 `/model` 切换后下一次响应会无缓存重读完整历史。因此上述 bug 可以确定存在于本地泄露版架构和相应公开报告中，但不能仅凭本地源码断言它仍存在于 Claude Code 2.1.220。

## 十一、最新版客户端相对旧版 4.6 客户端可能增加什么

如果固定模型为 Opus 4.6，只升级 Claude Code 客户端，变化可能来自以下层次。

### 11.1 主体 prompt 演进

- 编码和验证规则调整
- 输出效率和沟通风格调整
- Git、PR 和权限规则调整
- Memory 和 Session guidance 演进
- 新的 context management、scratchpad、summarization 规则
- lean/legacy prompt 分支选择

### 11.2 工具演进

- 新工具
- 工具重命名或替换
- description 更新
- input/output schema 更新
- ToolSearch 和 deferred loading
- MCP 工具描述长度限制
- 工具缓存和 prompt caching 调整

### 11.3 Agent loop 演进

- 后台 Agent
- worktree
- Agent teams
- workflows
- task lifecycle
- completion notification
- permission classifier
- context compaction

### 11.4 模型能力判断演进

- Opus 4.6 支持哪些 effort
- 是否允许 strict tools
- thinking 配置
- 1M context
- max output tokens
- fast mode
- provider-specific beta headers

所以相同的 Opus 4.6，在不同 Claude Code 客户端版本中可能表现明显不同。这种差异不能全部归因于模型。

## 十二、公开讨论能够证明什么

公开社区中确实有人讨论“同一模型在不同 Claude Code 版本中行为不同”。

### 12.1 模型切换后 system metadata 未更新

`anthropics/claude-code#36835` 报告 `/model` 切换后系统元数据仍显示旧模型。这与本地源码的 `env_info_simple` 缓存问题一致。

### 12.2 客户端 scaffold/system prompt 影响模型表现

`anthropics/claude-code#7513` 报告用户在固定 Opus 的情况下，回退 Claude Code 客户端版本后表现发生变化，并推测原因是 scaffold/system prompt。

`anthropics/claude-code#45704` 也讨论了泄露 prompt 中 Output Efficiency 指令对行为的影响。

参考：

- [anthropics/claude-code#7513](https://github.com/anthropics/claude-code/issues/7513)
- [anthropics/claude-code#45704](https://github.com/anthropics/claude-code/issues/45704)

这些 issue 可以证明社区确实把“模型版本”和“Claude Code harness 版本”当成两个变量讨论，但它们属于用户报告，不能单独作为官方内部实现的权威证据。

## 十三、`--system-prompt-file` 对上述行为的影响

本地自定义 prompt 选择逻辑：

- `src/utils/systemPrompt.ts:115`

优先顺序大致为：

```text
main-thread custom agent prompt
    >
customSystemPrompt
    >
defaultSystemPrompt
```

所以执行：

```bash
claude \
  --model claude-opus-4-6 \
  --system-prompt-file "/path/to/custom-prompt.md"
```

会全量替换默认内置 system prompt 主体。

这时：

- 内置 lean/legacy 主体选择对被替换部分不再生效。
- 模型仍然切换为 `claude-opus-4-6`。
- 工具定义仍由当前客户端发送。
- thinking、effort、context、max tokens 等仍按模型能力决定。
- API attribution/prefix 等底层系统块仍可能由客户端在后续请求构造阶段补充。
- CLAUDE.md、hooks、attachments 和工具结果等不等于被全部删除，它们可能通过其他上下文路径进入请求。

因此，使用 `--system-prompt-file` 后比较模型时，模型差异更纯粹；但它不等于旧版 Claude Code，因为工具和运行时仍然来自当前客户端。

## 十四、如何进行可靠对比

### 14.1 比较模型本身

目标：比较 Opus 4.6 与 Opus 4.7/4.8/5。

需要固定：

- 同一个 Claude Code 客户端版本
- 相同 system prompt
- 相同工具集
- 相同权限模式
- 相同 CLAUDE.md
- 相同 effort/thinking
- 相同任务与初始上下文

只改变：

```text
model ID
```

### 14.2 比较 Claude Code 客户端 harness

目标：比较旧版和最新版 Claude Code。

需要固定：

- 相同模型 ID，例如 `claude-opus-4-6`
- 相同任务
- 相同项目状态
- 相同权限
- 相同 provider

只改变：

```text
Claude Code 客户端版本
```

但要记录新旧客户端发送的：

- system prompt
- tool names
- tool descriptions
- tool schemas
- thinking/effort 参数
- context window 和 max tokens

否则不能判断差异来自哪一层。

### 14.3 验证实际模型

不要使用：

```text
你是什么模型？
```

模型只能根据 system metadata 回答，而该 metadata 可能错误或缓存过期。

应优先使用：

```text
/status
```

在非交互 JSON 或 `stream-json` 场景下，应检查最终 result message 的：

```text
modelUsage
```

官方文档也建议在发生退休或自动 remap 时通过实际结果确认模型。

## 十五、最终判断

### 对真正的最新版 Claude Code

切换到 Opus 4.6 后：

- 底层模型是固定的 Opus 4.6 快照。
- 当前官方仍将 Opus 4.6 列为 Active。
- 最新版不会自动恢复到旧版 Claude Code。
- 会使用最新版维护的旧模型/legacy prompt 路径，而不是新模型默认 lean prompt。
- 会保留最新版客户端的工具、工具 Schema、权限和 agent-loop。
- 部分能力会因为 Opus 4.6 的模型能力而关闭或调整。

### 对当前 cc-haha

强制指定 `claude-opus-4-6` 后：

- API 请求模型 ID 会继续发送 4.6。
- 公共主体 prompt 与 4.7 基本相同。
- 当前客户端工具仍然存在。
- Environment 会错误地把 4.6 泛化成 `Opus 4`。
- knowledge cutoff 会错误退化为 January 2025。
- latest model 和 fast mode 文案仍然指向 Opus 4.7。
- 同会话切换还可能因为 prompt section cache 保留之前模型的 Environment。

### 最精确的一句话

> 最新 Claude Code 运行 Opus 4.6，得到的是“Opus 4.6 固定模型快照 + 最新客户端为旧模型维护的系统提示词分支 + 最新工具与运行时”，而不是“当年的旧版 Claude Code”，也不是“只换工具、主体提示词完全不变”。

## 十六、主要源码位置

| 作用 | 文件与位置 |
| --- | --- |
| 默认系统提示词组装 | `src/constants/prompts.ts:458` |
| Environment 与模型描述 | `src/constants/prompts.ts:663` |
| knowledge cutoff | `src/constants/prompts.ts:724` |
| prompt section 缓存 | `src/constants/systemPromptSections.ts:17` |
| 自定义 prompt 替换优先级 | `src/utils/systemPrompt.ts:115` |
| 模型输入解析 | `src/utils/model/model.ts:477` |
| canonical model mapping | `src/utils/model/model.ts:239` |
| marketing model name | `src/utils/model/model.ts:602` |
| 基础工具列表 | `src/tools.ts:194` |
| 工具转 API Schema | `src/utils/api.ts:119` |
| API tool schema 构建 | `src/services/api/claude.ts:1281` |
| API system prompt 最终拼接 | `src/services/api/claude.ts:1408` |
| API `model/system/tools` 请求结构 | `src/services/api/claude.ts:1764` |

## 十七、官方参考资料

- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
- [Claude model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- [anthropics/claude-code#36835](https://github.com/anthropics/claude-code/issues/36835)
- [anthropics/claude-code#7513](https://github.com/anthropics/claude-code/issues/7513)
- [anthropics/claude-code#45704](https://github.com/anthropics/claude-code/issues/45704)
