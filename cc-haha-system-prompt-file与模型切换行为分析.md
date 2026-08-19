# cc-haha `--system-prompt-file` 与模型切换行为分析

## 1. 分析问题

本文回答以下场景：

```bash
claude \
  --model claude-opus-4-7 \
  --system-prompt-file "/path/to/修改后的-opus-4.7.md"
```

启动后，再通过 `/model` 或模型选择器切换到 Sonnet 4.6：

1. 默认的 Opus 4.7/Sonnet 4.6 动态 prompt 是否继续生成和拼接。
2. Sonnet 4.6 最终收到的是 Sonnet prompt 还是固定的 Opus prompt。
3. 哪些内容仍然会在 custom prompt 外动态加入。
4. 实际服务端模型是否会被 prompt 中的模型名称影响。

## 2. 核心结论

普通主会话使用 `--system-prompt-file` 后，文件内容会作为一个固定
`customSystemPrompt`，替换 `getSystemPrompt()` 生成的默认 Claude Code prompt。

切换到 Sonnet 4.6 后：

```text
实际 API model：claude-sonnet-4-6
custom system prompt：仍是启动时读取的“修改后的 Opus 4.7.md”
默认 Sonnet Environment：不会自动替换进来
默认 Sonnet knowledge cutoff：不会自动替换进来
真实工具池：仍由当前运行时通过 API tools 字段发送
```

因此，如果 custom 文件中明确写着：

```text
You are powered by the model named Opus 4.7.
The exact model ID is claude-opus-4-7.
Assistant knowledge cutoff is May 2025.
```

那么切换后会出现：

```text
真实运行模型：Sonnet 4.6
模型收到的自我描述：Opus 4.7
```

prompt 中写着 Opus 4.7 不会把服务端模型重新变成 Opus 4.7，但会给实际运行的
Sonnet 4.6 提供错误的模型身份和能力说明。

## 3. `--system-prompt-file` 如何读取文件

CLI 在启动时读取文件：

```text
src/main.tsx:1346-1365
```

核心代码：

```ts
const filePath = resolve(options.systemPromptFile)
systemPrompt = readFileSync(filePath, 'utf8')
```

这意味着：

- 文件按 UTF-8 纯文本读取。
- Markdown 没有特殊 Schema 要求。
- 文件内容被读入一个字符串。
- 文件名是否包含 `Opus` 不影响程序行为，真正产生影响的是文件正文。
- CLI 启动后修改磁盘上的 Markdown，不会自动重新读取；需要重新启动进程。

## 4. 默认 prompt 与 custom prompt 的选择

选择逻辑位于：

```text
src/utils/systemPrompt.ts:41-122
```

普通分支的核心逻辑是：

```ts
return asSystemPrompt([
  ...(agentSystemPrompt
    ? [agentSystemPrompt]
    : customSystemPrompt
      ? [customSystemPrompt]
      : defaultSystemPrompt),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

它不是：

```text
defaultSystemPrompt + customSystemPrompt
```

而是三选一：

```text
agentSystemPrompt
否则 customSystemPrompt
否则 defaultSystemPrompt
```

所以，只要普通会话存在 `customSystemPrompt`，默认 `getSystemPrompt()` 的结果就不会
成为有效 system prompt 正文。

## 5. 被 custom prompt 替换掉的默认内容

默认 prompt 来自：

```text
src/constants/prompts.ts:458-589
```

使用 `--system-prompt-file` 后，以下默认段不会自动进入有效 prompt：

### 静态公共段

- Intro。
- System。
- Doing tasks。
- Executing actions with care。
- Using your tools。
- Tone and style。
- Output efficiency。

### 动态段

- Session-specific guidance。
- 默认 Memory mechanics。
- 默认 Environment。
- 模型营销名称和精确 model ID。
- Knowledge cutoff。
- Language。
- Output style。
- MCP server instructions。
- Scratchpad 具体路径。
- Function Result Clearing。
- Tool-result summarization。

因此，原本由 `computeSimpleEnvInfo(model)` 区分 Opus 4.7 和 Sonnet 4.6 的逻辑不会
自动覆盖 custom 文件中的模型描述。

## 6. 交互式与非交互式路径

### 6.1 交互式 REPL

REPL 当前仍会调用：

```text
src/screens/REPL.tsx:2769-2788
```

它先计算 `defaultSystemPrompt`，再调用 `buildEffectiveSystemPrompt()`。

当 custom prompt 存在时，计算出来的 `defaultSystemPrompt` 会被选择逻辑丢弃。
所以可能发生“源码计算了默认 prompt”，但不代表这些默认段被发给模型。

从最终请求角度看，生效的仍是 custom prompt。

### 6.2 Print、SDK 和部分 headless 路径

共享 helper 明确跳过默认 prompt：

```text
src/utils/queryContext.ts:30-73
```

逻辑为：

```ts
customSystemPrompt !== undefined
  ? Promise.resolve([])
  : getSystemPrompt(...)
```

该路径还会在 custom prompt 存在时跳过 `getSystemContext()`。

因此非交互式路径比 REPL 更直接：默认 prompt 甚至不会被构建。

## 7. 模型切换后哪些东西会变化

虽然 custom prompt 文本不变，但模型切换仍会改变真实 API 请求和运行时能力。

### 7.1 API `model`

最终请求位于：

```text
src/services/api/claude.ts:1764-1788
```

核心字段：

```ts
{
  model: normalizeModelStringForAPI(options.model),
  system,
  tools: allTools,
  max_tokens,
  thinking,
  betas
}
```

切换到 Sonnet 4.6 后：

```json
{
  "model": "claude-sonnet-4-6"
}
```

所以 Anthropic 服务端实际运行 Sonnet 4.6。System prompt 无权改写 API 的
`model` 字段。

### 7.2 运行时模型能力

以下内容仍可能按 Sonnet 4.6 重新计算：

- thinking 参数。
- effort。
- max output tokens。
- beta headers。
- context management。
- structured outputs。
- Tool Search 和 `tool_reference`。
- Advisor 能力。
- provider 兼容逻辑。

这些属于 API 参数和运行时能力，不依赖默认 system prompt 是否被替换。

### 7.3 真实工具

真实工具通过独立的 `tools` 字段发送：

```text
src/services/api/claude.ts:1281-1296
src/services/api/claude.ts:1775-1776
```

所以 custom Markdown 中写出的工具说明不会注册工具，也不会替代 API 工具 Schema。

模型切换后，运行时仍会根据当前模型能力过滤或调整真实工具。

## 8. custom prompt 外仍会加入的内容

`--system-prompt-file` 替换的是默认正文，但最终 API `system` 并不一定只有这个文件。

API 在：

```text
src/services/api/claude.ts:1408-1418
```

按以下顺序组装：

```text
Attribution header
Claude Code / Claude Agent SDK identity prefix
custom system prompt
可选 append system prompt
可选 Advisor tool instructions
可选 Chrome tool-search instructions
```

### 8.1 Claude Code identity prefix

普通交互式会话仍会收到：

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

定义位置：

```text
src/constants/system.ts:10
```

所以 custom 文件中再次写同样身份会形成重复，但通常不会直接导致请求失败。

### 8.2 Attribution header

API 还可能添加 Claude Code attribution/billing header。它不是模型行为 prompt，
主要用于客户端识别、计费和服务端校验。

### 8.3 `--append-system-prompt`

如果同时配置 append prompt，它会追加在 custom prompt 后面。

### 8.4 Advisor 和 Chrome

在对应能力启用时，API 层可能继续追加 Advisor 或 Chrome tool-search 指令。

这些内容不会把 custom Opus prompt 自动转换为 Sonnet prompt。

## 9. 与默认 Environment 缓存问题的关系

不使用 custom prompt 时，默认 `Environment` 通过：

```text
systemPromptSection('env_info_simple', ...)
```

缓存。会话内切换模型可能沿用旧模型的 Environment，这是另一份报告中记录的缓存
一致性问题。

使用 `--system-prompt-file` 后，普通有效 prompt 不再使用默认 Environment，因此
问题不再是“默认 Environment 缓存没有刷新”，而是更直接的：

```text
custom 文件从一开始就是固定文本
```

即使清除 `env_info_simple` cache，也不会修改 custom 文件中的 Opus 4.7 描述。

## 10. 具体场景推演

### 10.1 启动 Opus 4.7

命令：

```bash
claude \
  --model claude-opus-4-7 \
  --system-prompt-file "/path/to/修改后的-opus-4.7.md"
```

请求可简化为：

```text
model = claude-opus-4-7
system = Claude Code prefix + 修改后的 Opus 4.7 prompt
tools = cc-haha 当前实际工具 Schema
```

模型 ID 与 prompt 描述一致。

### 10.2 会话中切换到 Sonnet 4.6

切换后请求变为：

```text
model = claude-sonnet-4-6
system = Claude Code prefix + 修改后的 Opus 4.7 prompt
tools = 按当前运行时和 Sonnet 能力处理后的实际工具 Schema
```

模型 ID 与 prompt 描述可能冲突。

### 10.3 使用同一个文件直接启动 Sonnet

命令：

```bash
claude \
  --model claude-sonnet-4-6 \
  --system-prompt-file "/path/to/修改后的-opus-4.7.md"
```

结果与切换后一致：

```text
真实模型 = Sonnet 4.6
固定 prompt = Opus 4.7 版本
```

## 11. 可能造成的实际影响

这种冲突通常不会让 API 请求立即失败，因为 system prompt 只是文本。

但可能带来：

- Sonnet 自称 Opus 4.7。
- 模型依据错误 knowledge cutoff 回答。
- 错误理解自己的上下文窗口、thinking 或 fast-mode 能力。
- 遵循专门针对 Opus 行为调优、但不适合 Sonnet 的规则。
- 如果文件包含完整捕获，继续使用过期 Memory、Scratchpad、Git 状态和工具说明。
- 调试模型行为时混淆“真实模型”和“prompt 中声明的模型”。

不会发生的事情：

- Prompt 不会将 Sonnet 4.6 升级成 Opus 4.7。
- Prompt 不会解锁订阅账号未开放的模型。
- Prompt 中的工具 Schema 不会注册真实工具。
- 修改 Markdown 中的 model ID 不会修改 API `model` 字段。

## 12. 推荐方案

### 12.1 需要在同一会话切换模型

将 custom prompt 改成模型中立版本，删除：

```text
Opus 4.7
claude-opus-4-7
May 2025
固定 context window
固定 thinking/effort 能力
固定 fast-mode 能力
```

保留：

- Claude Code 行为规则。
- 编码、Git、权限和验证规范。
- 用户沟通规范。
- 模型无关的 Memory、Environment 和 context-management 职责。

这样切换实际模型时不会产生错误身份冲突。

### 12.2 只想修改少量规则

优先使用：

```bash
claude \
  --model claude-opus-4-7 \
  --append-system-prompt-file "/path/to/自定义补充规则.md"
```

这样默认 prompt 继续负责：

- 当前模型名称与 ID。
- Knowledge cutoff。
- Session guidance。
- Memory。
- Environment。
- MCP。
- Scratchpad。
- 运行时 feature/config 段。

你的文件只增加需要修改的行为规则。

对于需要在 Opus 4.7 和 Sonnet 4.6 之间切换的场景，append 通常比全量替换更稳妥。

### 12.3 确实需要模型专属全量 prompt

为不同模型分别启动进程并选择对应文件：

```bash
claude \
  --model claude-opus-4-7 \
  --system-prompt-file "/path/to/opus-4.7.md"
```

```bash
claude \
  --model claude-sonnet-4-6 \
  --system-prompt-file "/path/to/sonnet-4.6.md"
```

不要在加载 Opus 专属 prompt 的进程中切换到 Sonnet，反之亦然。

### 12.4 从源码层保留动态段

更完整的长期方案不是把完整运行时 prompt 冻结成 Markdown，而是修改组合逻辑：

```text
custom static core
+ runtime Environment(model)
+ runtime Memory
+ runtime MCP
+ runtime Scratchpad
+ runtime feature/config sections
```

这需要改变 `buildEffectiveSystemPrompt()` 或拆分 `getSystemPrompt()` 的静态和动态职责，
并补充模型切换、headless、prompt caching 和 custom-agent 回归测试。

## 13. 特殊优先级例外

普通 custom prompt 不是绝对最高优先级：

```text
override prompt
coordinator prompt
agent prompt
custom prompt
default prompt
```

因此：

- Loop/override 模式可以完全替换 custom prompt。
- Coordinator mode 可以优先于 custom prompt。
- 主线程 Agent prompt 可以优先于 custom prompt。
- Proactive mode 对 Agent prompt 有特殊追加逻辑。

本文的主要结论针对没有上述特殊模式的普通主会话。

## 14. 最终回答

使用修改后的 Opus 4.7 文件作为 `--system-prompt-file` 后：

```text
默认 Opus/Sonnet prompt 动态替换：不会进入普通有效 prompt
切换 Sonnet 后 custom 文件：不会改变
切换 Sonnet 后真实 API model：会变成 claude-sonnet-4-6
Sonnet 是否仍收到 Opus 文本：如果文件写了 Opus，是
真实工具是否继续动态发送：是
Claude Code 公共身份前缀是否仍加入：是
```

因此，“使用 Opus 4.7 prompt 的 Sonnet 4.6”在技术上完全可能发生。准确描述是：

```text
Sonnet 4.6 模型 + 固定 Opus 4.7 system prompt
```

这不是模型升级或降级，而是实际模型与 system prompt 自我描述不一致。
