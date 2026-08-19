# cc-haha `--system-prompt-file` 全量替换边界分析

> 分析日期：2026-07-23
>
> 分析对象：当前 `/Volumes/zhitai-7100/personal/cc-haha` 源码

## 1. 核心结论

当前 `cc-haha` 内嵌的是 Claude Code coding-agent 提示体系，不是
Claude.ai/Fable 产品提示词。

这里需要区分两种“正确”：

- **输入格式正确**：任何 UTF-8 文本都能被 `--system-prompt-file` 读取。
- **运行时语义正确**：文件内容必须与 Claude Code harness、实际工具、路径和动态
  上下文匹配。

`claude.ai` 的完整 system prompt 在第一种意义上合法，但在第二种意义上不是
Claude Code 默认正文的等价替代。

执行：

```bash
claude \
  --model claude-opus-4-8 \
  --system-prompt-file \
  "/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Opus-4.8替换系统提示词.md"
```

时，`--system-prompt-file` 替换的是主会话中 `getSystemPrompt()` 生成的
Claude Code 默认 system prompt 正文。

它不是对整个请求或仓库内所有提示词的全局替换。以下内容不会因此被替换：

- 实际 model ID。
- API `tools` 字段中的工具说明和 JSON Schema。
- Claude Code/Agent SDK 身份前缀。
- Attribution/billing header。
- `CLAUDE.md` 和当前日期组成的 user context。
- 用户消息、工具结果、Hook 结果和动态 attachments。
- 权限系统、thinking、betas、context management 和 max tokens。
- 其他内部工作流各自使用的专用 prompt。

因此，“全量替换”更准确的含义是：

```text
全量替换默认 Claude Code system prompt 正文
                    !=
全量替换模型收到的所有上下文和运行时能力
```

## 2. 为什么直接渲染时出现初始化保护

此前使用 `bun -e` 直接导入并调用 `getSystemPrompt()` 时，第一次出现：

```text
Error: Config accessed before allowed.
```

这不是文件权限、系统沙箱、仓库权限或用户授权造成的。

`src/utils/config.ts` 使用一个进程内初始化标志：

```ts
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) return
  configReadingAllowed = true
  getConfig(...)
}
```

正常 CLI 启动入口会先执行 `enableConfigs()`，然后才允许业务模块读取配置。直接
导入 `getSystemPrompt()` 绕过了正常启动顺序；该函数在生成 prompt 时会间接读取
settings、commands、登录状态等配置，于是保护逻辑主动抛错。

按正常顺序先调用 `enableConfigs()` 后，prompt 可以正常渲染。

这个保护的目的，是防止模块初始化阶段过早读取配置并形成隐藏的启动顺序依赖。它
与是否授予终端、文件系统或网络权限无关。

关键位置：

- `src/utils/config.ts:1331`：`configReadingAllowed`。
- `src/utils/config.ts:1334`：`enableConfigs()`。
- `src/utils/config.ts:1427`：未初始化时抛错。

## 3. `--system-prompt-file` 的文件格式

当前 CLI 没有为该参数定义 Anthropic 专用的 JSON、YAML 或 Markdown Schema。

`src/main.tsx` 的实现本质上只是：

```ts
const filePath = resolve(options.systemPromptFile)
systemPrompt = readFileSync(filePath, 'utf8')
```

所以它接受任意 UTF-8 纯文本：

- 可以使用 `.md`。
- 可以使用 `.txt`。
- 可以没有扩展名。
- 不需要 YAML frontmatter。
- 不需要 JSON 请求外壳。
- Markdown 标题、列表、代码块和 XML 标签都只是给模型阅读的文本结构。

不应该把完整 Anthropic Messages API 请求写入这个文件，例如：

```json
{
  "model": "claude-opus-4-8",
  "system": "...",
  "tools": []
}
```

也不应该在该文件中复制工具 `input_schema`。真正的工具定义由 CLI 通过 API
`tools` 字段独立发送。

关键位置：

- `src/main.tsx:1346`：处理 system prompt 参数。
- `src/main.tsx:1354`：解析路径并读取 UTF-8 文件。

## 4. 当前仓库里的 Claude Code 默认提示词

当前仓库确实包含 Opus 4.7 使用的 Claude Code 提示词源码，但它不是单一 Markdown
文件，而是动态提示体系。

主要组成包括：

| 位置 | 职责 |
| --- | --- |
| `src/constants/prompts.ts` | 默认 system prompt 的静态段和动态段 |
| `src/constants/system.ts` | Claude Code/Agent SDK 身份前缀和 attribution |
| `src/constants/systemPromptSections.ts` | 动态段的缓存和重新计算 |
| `src/tools/*/prompt.ts` | 每个真实工具的文字说明 |
| 各工具 `inputSchema` | API 工具参数 JSON Schema |
| `src/context.ts` | `CLAUDE.md`、日期、Git status 等上下文 |
| `src/utils/attachments.ts` | Skills、MCP、嵌套规则等动态附件 |

`src/constants/prompts.ts:getSystemPrompt()` 的默认主结构是：

```ts
return [
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  getSimpleDoingTasksSection(),
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  ...resolvedDynamicSections,
]
```

当前工作树使用 `claude-opus-4-7`、空工具数组和当前本机设置进行实测时，
`getSystemPrompt()` 返回：

- 11 个字符串块。
- 合并后 24,744 个字符。
- 约 3,883 个以空白分隔的词项。

工具 Schema 不包含在上述数字中，它们会另外进入 API `tools` 字段。真实运行使用
完整工具池时，部分工具相关动态说明还会发生变化。

主要章节包括：

```text
# System
# Doing tasks
# Executing actions with care
# Using your tools
# Tone and style
# Output efficiency
# auto memory
# Environment
```

这套正文属于 Claude Code coding-agent harness。它和 Claude.ai/Fable 产品 prompt
的产品界面、Artifacts、地图、天气、菜谱、连接器等指令不是一套东西。

需要注意，当前 `src/constants/prompts.ts` 存在用户尚未提交的本地修改，其中加入了
自定义 `# 安全过滤器`。这个修改属于当前默认 `getSystemPrompt()` 的一部分，使用
`--system-prompt-file` 后也会被绕过。

## 5. 普通 Interactive 会话中替换了什么

Interactive REPL 每轮都会先生成：

```ts
const [defaultSystemPrompt, baseUserContext, systemContext] =
  await Promise.all([
    getSystemPrompt(...),
    getUserContext(),
    getSystemContext(),
  ])
```

然后调用：

```ts
buildEffectiveSystemPrompt({
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
})
```

普通主会话中，核心选择为：

```ts
customSystemPrompt
  ? [customSystemPrompt]
  : defaultSystemPrompt
```

因此文件内容替换下列 `getSystemPrompt()` 默认正文：

- Claude Code coding-agent intro。
- `# System`。
- 当前本地自定义的 `# 安全过滤器`。
- `# Doing tasks`。
- `# Executing actions with care`。
- `# Using your tools`。
- `# Tone and style`。
- `# Output efficiency`。
- Session-specific guidance。
- Auto Memory mechanics。
- Environment、平台、工作目录和模型说明。
- Language 设置。
- Output Style。
- MCP server instructions。
- Scratchpad instructions。
- Function-result clearing。
- Tool-result summarization。
- Token budget 等 feature-gated 动态说明。

但是 Interactive 模式仍然单独读取 `getSystemContext()`。Git status 和 cache breaker
等 system context 随后仍可能追加到 system prompt。

关键位置：

- `src/screens/REPL.tsx:2769`：同时读取三类 context。
- `src/screens/REPL.tsx:2782`：构造有效 system prompt。
- `src/utils/systemPrompt.ts:115`：custom/default 的选择逻辑。

## 6. `-p`、Headless 和 SDK 路径的替换差异

Headless/SDK 路径使用 `fetchSystemPromptParts()`。

当 `customSystemPrompt` 存在时：

```ts
customSystemPrompt !== undefined
  ? Promise.resolve([])
  : getSystemPrompt(...)
```

并且：

```ts
customSystemPrompt !== undefined
  ? Promise.resolve({})
  : getSystemContext()
```

所以在该路径中：

- 默认 `getSystemPrompt()` 完全不执行。
- `getSystemContext()` 也不执行。
- Git status 等 system context 通常不会注入。
- `getUserContext()` 仍然执行。
- `CLAUDE.md` 和当前日期仍然存在。
- 如果显式配置 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`，可能另外加入 Memory
  mechanics prompt。
- `appendSystemPrompt` 仍然追加。

关键位置：

- `src/utils/queryContext.ts:34`：源码注释直接说明替换行为。
- `src/utils/queryContext.ts:61`：跳过默认 prompt 和 system context。
- `src/QueryEngine.ts:312`：可选 Memory mechanics。
- `src/QueryEngine.ts:323`：最终 headless system prompt 数组。

## 7. 不会被替换的 API system blocks

在发送 API 请求之前，`src/services/api/claude.ts` 还会重新组装 system blocks：

```ts
systemPrompt = asSystemPrompt([
  getAttributionHeader(fingerprint),
  getCLISyspromptPrefix(...),
  ...systemPrompt,
  ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
  ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
])
```

因此即使使用 `--system-prompt-file`，仍可能存在：

1. Attribution/billing header。
2. Claude Code 或 Agent SDK 身份前缀。
3. 你的 custom Markdown。
4. `--append-system-prompt-file` 内容。
5. Teammate addendum。
6. Advisor instructions。
7. Claude in Chrome tool-search instructions。
8. Interactive 模式追加的 Git status/system context。

默认 interactive 身份前缀是：

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

所以 `--system-prompt-file` 不是“API 的 system 数组只能剩下这个文件”，而是“这个
文件取代默认 Claude Code 正文，并继续与 API 层固定或动态 blocks 组合”。

关键位置：

- `src/constants/system.ts:10`：Claude Code 身份前缀。
- `src/services/api/claude.ts:1408`：API 前的 system blocks 组装。
- `src/utils/api.ts:321`：system blocks 和 prompt cache 的拆分。

## 8. 不会被替换的工具系统

工具不是通过 `getSystemPrompt()` 注册的。

`src/utils/api.ts:toolToAPISchema()` 将每个工具转换为：

```ts
{
  name: tool.name,
  description: await tool.prompt(...),
  input_schema,
}
```

最终 API 请求同时发送：

```ts
{
  model,
  messages,
  system,
  tools: allTools,
  tool_choice,
  max_tokens,
  thinking,
}
```

所以使用 custom system prompt 后：

- `Bash`、`Read`、`Edit`、`Write` 等真实工具仍然存在。
- MCP 工具仍然按连接状态进入 `tools`。
- 每个 `src/tools/*/prompt.ts` 的工具说明仍然发送。
- 工具 `input_schema` 仍然发送。
- 权限检查和工具执行逻辑不变。

这也是为什么不应把 Claude.ai/Fable prompt 中的伪工具说明放入
`--system-prompt-file`：它们不会注册工具，只会与 API 提供的真实工具说明发生
冲突。

关键位置：

- `src/utils/api.ts:119`：工具 Schema 转换。
- `src/services/api/claude.ts:1764`：最终请求。
- `src/services/api/claude.ts:1775`：`system`。
- `src/services/api/claude.ts:1776`：`tools`。

## 9. `CLAUDE.md`、日期和 Git status

`getUserContext()` 返回：

```ts
{
  claudeMd,
  currentDate,
}
```

这些内容会通过一个 `<system-reminder>` 包装的 meta user message 放到消息列表前面，
不属于被替换的默认 system prompt。

因此 Interactive 和 Headless 模式通常都会继续看到：

- 用户级 `CLAUDE.md`。
- 项目级 `CLAUDE.md`。
- `.claude/CLAUDE.md`。
- `.claude/rules/*.md`。
- 当前日期。

`getSystemContext()` 主要包含 Git status 和可选 cache breaker：

- Interactive 使用 custom prompt 时仍会读取和追加。
- Headless/SDK 使用 custom prompt 时明确跳过。

关键位置：

- `src/context.ts:116`：`getSystemContext()`。
- `src/context.ts:155`：`getUserContext()`。
- `src/utils/api.ts:449`：把 user context 放入 meta user message。

## 10. Attachments 和 System Reminders

以下内容主要通过 messages/attachments 注入，不依赖默认
`getSystemPrompt()`：

- 用户文件附件。
- Tool result。
- Hook result。
- Skill discovery/listing。
- MCP instruction delta。
- Deferred tools delta。
- 嵌套目录 `CLAUDE.md` 和 conditional rules。
- Plan mode、permission mode 和 agent 状态。
- Teammate mailbox 和 team context。
- Compaction 后重新注入的附件。

所以 custom system prompt 不会让这些机制整体消失。

它可能删除默认正文中“如何使用这些机制”的说明，但运行时仍可能继续发送对应附件
和工具。这正是替换文件应包含通用规则“只使用运行时实际暴露或注入的能力”的原因。

## 11. 优先级例外

`buildEffectiveSystemPrompt()` 的实际优先级不是 custom prompt 永远最高：

```text
override system prompt
> coordinator system prompt
> main-thread agent prompt
> --system-prompt-file
> default getSystemPrompt()
```

因此：

- Loop/internal override 可以完全覆盖 custom prompt。
- Coordinator mode 可以使用 coordinator prompt 而不是 custom prompt。
- 指定 main-thread `--agent` 时，agent prompt 通常优先于 custom prompt。
- Proactive 模式还有自己的组合逻辑。
- Teammate addendum 和 append prompt 可能继续追加。

所以该参数只保证替换普通主会话的默认正文，不是对所有 agent、compact、title、
prompt suggestion 或其他内部请求的全局覆盖。

关键位置：

- `src/utils/systemPrompt.ts:28`：优先级注释。
- `src/utils/systemPrompt.ts:56`：override。
- `src/utils/systemPrompt.ts:62`：coordinator。
- `src/utils/systemPrompt.ts:77`：agent prompt。
- `src/utils/systemPrompt.ts:115`：最终选择。

## 12. 最终请求结构

普通 Interactive 会话可以概括为：

```text
API model
  --model/config 解析出的真实 model ID

API system
  attribution header
  Claude Code identity prefix
  custom Markdown
  append prompt / teammate addendum
  Git status/system context
  可选 advisor/Chrome instructions

API messages
  CLAUDE.md + 当前日期 meta message
  动态 attachments/system reminders
  用户消息
  assistant 历史
  tool results

API tools
  当前真实工具 description
  当前真实工具 input_schema

API runtime parameters
  thinking
  betas
  max_tokens
  context_management
  tool_choice
```

Headless/SDK/`-p` 使用 custom prompt 时主要区别是：

```text
API system
  通常没有 getSystemContext() 提供的 Git status
  其余仍按对应运行时路径组装

API messages
  仍包含 CLAUDE.md 和当前日期
```

## 13. 对 Opus 4.8 的含义

`--system-prompt-file` 不负责选择或解锁 Opus 4.8。

真正模型由以下内容共同决定：

1. `--model claude-opus-4-8`。
2. `cc-haha` 的模型解析和 provider 路由。
3. OAuth/订阅账号权限。
4. Anthropic 服务端是否接受该 model ID。
5. 服务端最终返回的 `message.model`。

修改 Markdown 中的文字，例如把：

```text
Claude Opus 4.7
```

替换为：

```text
Claude Opus 4.8
```

只会改变模型看到的文本，不会改变 API 请求的 `model` 字段。

同样，静态文件也无法自动补齐源码中可能存在的 Opus 4.8 适配缺口，例如：

- Model allowlist。
- Context window 映射。
- Thinking/effort 能力判断。
- Beta headers。
- Pricing。
- Tokenizer/context estimation。
- Provider-specific model mapping。
- UI model catalog。

## 14. `Anthropic/` 目录候选文件对比

### 14.1 目录中的文件不是同一种产品

`/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/README.md` 已明确标注各目录
的产品归属：

| 路径类型 | 实际产品面 | 是否适合替换 Claude Code 默认正文 |
| --- | --- | --- |
| 根目录 `claude-<model>.md` | Claude.ai Web/Mobile App | 否 |
| 根目录 `claude-*-no-tools.md` | Claude.ai 无工具模式 | 否 |
| `Official/*.md` | Anthropic 发布的 Claude.ai 核心 prompt | 否 |
| `raw/*.md` | Claude.ai 原始捕获 | 否 |
| `old/*.md` | 旧版 Claude.ai 捕获 | 否 |
| `claude-cowork*.md` | Claude Cowork | 否 |
| `claude-in-chrome.md` | Claude in Chrome | 否 |
| `claude-for-*.md` | Microsoft 365 产品 | 否 |
| `Claude Code/claude-code-<model>.md` | Claude Code harness 捕获 | 产品面正确，但完整文件仍不可直接使用 |
| `Claude Code/agents/` | 子 Agent 专用 prompt | 否 |
| `Claude Code/bundled-skills/` | 按需加载的 Skills | 否 |
| `Claude Code/injected-reminders/` | 按条件注入的提醒 | 否 |
| `Claude Code/mcp-servers/` | 特定 MCP server 指令和工具 | 否 |

所以不能只根据模型名选择文件。`claude-opus-4.8.md` 和
`claude-code-opus-4.8.md` 虽然都包含 `opus-4.8`，但属于两个不同产品运行时。

### 14.2 根目录 `claude-opus-4.8.md`

文件：

```text
/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/claude-opus-4.8.md
```

规模：

- 3,769 行。
- 24,784 个以空白分隔的词项。
- 183,530 字节。

**输入格式判断：正确。**

它是 UTF-8 文本，`--system-prompt-file` 可以完整读取。开头的 `System:`、
反引号包裹的 XML 标签、Markdown 标题和 JSON 工具定义都只会作为普通 system
文本进入模型上下文。

**作为 Claude Code 默认正文判断：不正确。**

它属于 Claude.ai 产品 prompt，主要包含：

- Claude.ai Web/Mobile 产品身份。
- Claude.ai 产品信息和 Settings。
- 通用对话、安全和内容规则。
- Web search、图片、地图、天气、菜谱、体育等产品工具。
- Artifacts 和持久化存储。
- Claude.ai citation/ANTML 协议。
- Claude.ai User Context、Skills、网络和 `/mnt/user-data` 文件系统。

这些字段不是当前 `getSystemPrompt()` 被替换部分的同构字段。它还会与 API 层继续
加入的 Claude Code 身份前缀、真实工具 Schema、当前 `CLAUDE.md` 和真实工作目录
形成混合环境。

结论：

```text
格式合法
产品面错误
不能作为 Claude Code Opus 4.8 的等价替换 prompt
```

### 14.3 根目录 `claude-opus-4.7.md`

文件：

```text
/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/claude-opus-4.7.md
```

规模：

- 3,735 行。
- 24,476 个以空白分隔的词项。
- 182,142 字节。

这个文件同样是 Claude.ai prompt，不是当前源码中
`src/constants/prompts.ts:getSystemPrompt()` 的来源。

虽然模型名和当前源码默认的 `claude-opus-4-7` 一致，但相同 model ID 不代表相同
产品 prompt。Claude.ai 和 Claude Code 会给同一个基础模型配不同 harness。

将整个根目录 `claude-opus-4.7.md` 作为 custom prompt：

- 不会恢复当前源码的 Claude Code coding-agent 规则。
- 不会与当前 `Bash`、`Read`、`Edit`、`Write` 等工具 Schema 对齐。
- 会引入 Claude.ai 工具、Artifacts、连接器和文件系统规则。
- 会删除默认的代码修改、测试、Git、权限和可逆操作正文。

结论：

```text
格式合法
模型名相同
产品面错误
不足以且不正确地替代当前源码的默认正文
```

### 14.4 `Claude Code/claude-code-opus-4.7.md`

文件：

```text
/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/Claude Code/claude-code-opus-4.7.md
```

这是与当前源码产品面最接近的候选。它使用 full prompt，system 部分的主要章节为：

```text
# System prompt
## System
## Doing tasks
## Executing actions with care
## Using your tools
## Tone and style
## Text output
## Session-specific guidance
## auto memory
## Environment
## Scratchpad Directory
## Context management
```

这些章节与当前 `src/constants/prompts.ts` 的 full prompt 构造基本同型。

实测对比：

- 当前源码 `getSystemPrompt([], "claude-opus-4-7")`：24,744 字符。
- 捕获文件在 `# Session context` 之前：28,652 字节。
- 对长度至少 20 字符的去重行进行精确比较，当前源码行覆盖率约 66.4%。
- Jaccard 相似度约 47.2%。

差异来自版本、feature flags、当前工作树修改、Memory、Environment、工具状态和
捕获方式。

但是整个文件有 170,565 字节，除了 system prompt，还打包了：

- `# Session context`。
- Git status。
- `CLAUDE.md`。
- User email 和日期。
- Agents 列表。
- Skills 列表。
- 完整 Tools descriptions 和 input schemas。

这些内容由当前 `cc-haha` 运行时另外生成或发送。完整文件原样传入会造成重复和
过时状态。

因此：

```text
当前源码产品面：最相符
整个文件直接使用：不正确
只研究 # Session context 之前的 system 段：有参考价值
```

即使只提取首段，也必须删除：

- `You are Claude Code...` 身份前缀，避免 API 层重复。
- 捕获者的 Memory 路径。
- 固定 Environment、model ID、OS 和 context 数字。
- 固定 Scratchpad 路径。
- 任何当前运行时会动态注入的内容。

### 14.5 `Claude Code/claude-code-opus-4.8.md`

文件：

```text
/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/Claude Code/claude-code-opus-4.8.md
```

这是目标模型 Opus 4.8 在 Claude Code 产品面最相符的候选。该捕获使用 lean
prompt，system 部分主要章节为：

```text
# System prompt
## Harness
## Communicating with the user
## Session-specific guidance
## Memory
## Environment
## Scratchpad Directory
## Context management
```

与 Opus 4.7 full prompt 相比，它不是简单把 `4.7` 改成 `4.8`，而是重写了主提示
结构。目录 README 说明，从 Claude Code 2.1.154 起，Opus 4.8 使用
`lean_prompt` capability；Opus 4.7 及更早版本继续使用 full prompt。

量化结果：

- `# Session context` 之前为 9,058 字节。
- 整个文件为 132,695 字节。
- 相对 `claude-code-opus-4.7.md`，文件 diff 为 75 行增加、478 行删除。

完整文件同样包含捕获时的：

- `/Users/asgeirtj/...` Memory 路径。
- `<project-dir>` 和 `<scratchpad-dir>`。
- 固定 OS、model ID、knowledge cutoff 和 context 描述。
- Session Context。
- Agents 和 Skills。
- 完整 Tools descriptions 和 schemas。

因此：

```text
目标 Opus 4.8 产品面：最相符
整个文件直接使用：不正确
只提取并清洗 system 段：可以作为重写参考
```

### 14.6 Claude Code 目录中其他模型

对该目录全部主模型捕获进行分类：

| 文件 | Prompt 类型 | 与当前源码/目标的关系 |
| --- | --- | --- |
| `claude-code-opus-4.6.md` | Full | 与 Opus 4.7 高度近似，但更旧 |
| `claude-code-opus-4.7.md` | Full | 最接近当前源码默认正文 |
| `claude-code-sonnet-4.6.md` | Full | 同代 full harness，不是目标模型 |
| `claude-code-haiku-4.5.md` | Full | 同类 full harness，但模型能力不同 |
| `claude-code-sonnet-5.md` | Full | 较新但仍为 Sonnet full prompt |
| `claude-code-opus-4.8.md` | Lean | 最接近目标 Opus 4.8 harness |
| `claude-code-fable-5.md` | Lean | 与 Opus 4.8 同属 lean，但身份和部分能力不同 |

`agents/`、`bundled-skills/`、`slash-commands/`、`injected-reminders/` 和
`mcp-servers/` 是按需拼装的其他提示通道，不能合并成一个静态
`--system-prompt-file`。

### 14.7 候选排序

如果问题是“哪个文件最接近当前源码被替换的部分”：

1. `Claude Code/claude-code-opus-4.7.md` 的 `# Session context` 之前部分。
2. `Claude Code/claude-code-opus-4.6.md` 的对应 system 部分。
3. 其他 Claude Code full prompt。
4. 根目录、`Official/`、`raw/` 和 `old/` Claude.ai 文件不属于同一产品面。

如果问题是“哪个文件最接近官方 Opus 4.8 的 Claude Code system prompt”：

1. `Claude Code/claude-code-opus-4.8.md` 的 `# Session context` 之前部分。
2. `Claude Code/claude-code-fable-5.md` 仅能参考 lean 结构。
3. `Claude Code/claude-code-opus-4.7.md` 是旧 full 结构。
4. 根目录 `claude-opus-4.8.md` 仍然是 Claude.ai，不应选择。

如果问题是“哪个完整文件可以不清洗直接传给 `--system-prompt-file`”：

```text
目录中的泄露捕获：没有一个完整文件适合直接使用。
```

当前生成的 `Claude-Code-Opus-4.8替换系统提示词.md` 已以 Opus 4.8 lean system
首段为直接基准重新编写。它保留 Harness、沟通、Session guidance、Memory、
Environment、Scratchpad 和 Context management 的职责，同时删除工具 Schema、
捕获者路径和动态会话状态，因而比直接传入任一完整捕获更可靠。它是清洗后的
运行时适配版本，不是官方 Opus 4.8 system prompt 的逐字副本。

### 14.8 “重复”与“不能静态复制”不是一回事

此前将所有清洗内容笼统称为“重复”不够准确，应分为三类。

#### 确实会重复或与运行时冲突

| 捕获内容 | 原因 |
| --- | --- |
| `You are Claude Code...` | `src/services/api/claude.ts` 会通过 `getCLISyspromptPrefix()` 再加入 |
| 完整 Tools descriptions 和 schemas | 当前真实工具通过 API `tools` 字段独立发送 |
| 捕获文件的 `CLAUDE.md` 和日期 | `getUserContext()` 仍会注入当前 `CLAUDE.md` 和日期 |
| Interactive 捕获中的 Git status | Interactive 仍调用 `getSystemContext()` 注入当前 Git status |
| 固定 Agents/Skills 列表 | 运行时会根据版本、模型 capability、feature flags 和当前配置提供 |
| MCP 和其他动态 instructions | 当前连接状态可能通过 system block 或 attachments 另行注入 |

这些内容整段保留会形成真正的重复，或者让模型同时看到两套名称、Schema 和状态。

#### 不一定重复，但属于捕获时动态值

| 捕获内容 | 为什么不能原样保留 |
| --- | --- |
| `/Users/asgeirtj/.../memory/` | 属于捕获者，不是当前用户的真实 Memory 路径 |
| `<project-dir>` | 是未解析占位符，不是运行时工作目录 |
| `<scratchpad-dir>` | 是未解析占位符，静态 Markdown 不会替换它 |
| `Darwin 25.5.0`、`zsh` | 只描述捕获机器 |
| 固定 Git repository 状态 | 很快过期，Headless custom path 即使不重复也仍然错误 |
| `claude-*-5[1m]` | prompt 无法证明实际 model ID 或 context entitlement |
| User email、日期、knowledge cutoff | 可能属于捕获账号、捕获日期或模型 registry 的旧状态 |

这些字段的主要问题是错误、过期或泄露，不是所有路径下都会重复。例如 Headless
custom prompt 会跳过 `getSystemContext()`，所以 Git status 不会重复；但把另一次
捕获的 Git status 写进去仍然不正确。

#### 不能删除职责，只能删除具体值

以下职责会随默认 `getSystemPrompt()` 一起被 custom prompt 替换。如果清洗时整节
删除，能力指导会丢失：

- Memory 的使用边界、持久化规则和过期校验。
- Environment 的真实性和检查规则。
- Scratchpad 的临时文件规则。
- Context management 和自动压缩后的继续工作规则。
- Coding、Git、权限、可逆操作和验证规则。

因此正确的清洗方式不是删除这些章节，而是：

```text
保留职责和行为约束
删除捕获者的具体路径、身份、环境值和会话状态
改为“仅在运行时提供具体值时启用”
```

### 14.9 三份生成的替换文件

当前仓库生成了三份针对不同 Claude Code prompt 类型的清洗版：

| 文件 | 参考捕获 | 结构 |
| --- | --- | --- |
| `Claude-Code-Opus-4.8替换系统提示词.md` | `claude-code-opus-4.8.md` | Lean |
| `Claude-Code-Fable-5替换系统提示词.md` | `claude-code-fable-5.md` | Lean，保留 Fable 自主完成和最终消息规则 |
| `Claude-Code-Sonnet-5替换系统提示词.md` | `claude-code-sonnet-5.md` | Full，保留 System、Doing tasks、Actions、Tools 和 Text output |

三份文件都：

- 不复制 API 已发送的工具 Schema。
- 不复制捕获者 Session Context、Agents 和 Skills 列表。
- 不硬编码捕获者路径、OS、Git 状态或 context entitlement。
- 保留 Memory、Environment、Scratchpad 和 Context management 的职责。
- 明确 prompt 文件本身不能选择或解锁模型。

### 14.10 直接使用完整 Sonnet 5 捕获的实际风险

直接使用：

```bash
claude \
  --model claude-sonnet-5 \
  --system-prompt-file "/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/Claude Code/claude-code-sonnet-5.md"
```

技术上可以运行。使用当前源码的 `buildEffectiveSystemPrompt()` 验证时，该文件
被接受为一个 170,906 字符的 custom system block，不会因 Markdown 格式或缺少
特定字段而报错。模型也经常能够从实际 API `tools` 列表中选出可调用工具。

通常影响较小的重复包括：

- `You are Claude Code...` 身份说明重复。
- 相同的沟通、编码和验证规则重复。
- 与当前运行时一致的工具说明重复。

这些重复主要增加上下文占用、输入成本和缓存前缀大小，通常不会单独导致严重故障。

但该文件的风险不只是重复：

- 整个文件为 171,512 字节，真正 system 首段只有 28,639 字节；约 142 KB 是
  Session Context、Agents、Skills 和 Tools 捕获。
- 捕获包含 33 个工具标题，当前工作树 `getAllBaseTools()` 得到 24 个。
- 两边只有 17 个工具名相同。
- 捕获独有 16 个工具：`Artifact`、`CronCreate`、`CronDelete`、`CronList`、
  `DesignSync`、`Monitor`、`PushNotification`、`RemoteTrigger`、
  `ReportFindings`、`ScheduleWakeup`、`TaskCreate`、`TaskGet`、`TaskList`、
  `TaskUpdate`、`WaitForMcpServers` 和 `Workflow`。
- 当前工作树独有 7 个工具：`Glob`、`Grep`、`TodoWrite`、`SendUserMessage`、
  `ListMcpResourcesTool`、`ReadMcpResourceTool` 和 `ToolSearch`。
- 捕获的 Memory 路径、Git status、`CLAUDE.md`、email、日期、OS 和 scratchpad
  状态不属于当前会话。
- 捕获中还静态包含固定模型描述、未解析的 `<scratchpad-dir>`、Agents、Skills
  和工具 Schema；它们可能与实际会话状态及 API 注册工具不一致。

所以更准确的判断是：

```text
一次性实验：大概率能运行
是否立即发生严重故障：通常不会
是否只是无害重复：不是
长期作为默认配置：不推荐
```

实际问题可能表现为更大的初始上下文、缓存前缀变大、模型提及或尝试不存在的工具、
使用错误 Memory/scratchpad 路径，以及依据过期 Session Context 做决定。
Prompt caching 可以降低部分重复输入的费用和延迟，但不会从 context window 中
移除缓存内容。

### 14.11 Opus 4.8 清洗版二次审查

二次审查发现，旧清洗版虽然为 9,080 字符，与捕获的 lean system 首段 9,058
字节接近，但长度接近不代表职责对应。旧版对 Memory mechanics 压缩过多。

当前修订版已恢复：

- 每个 durable fact 使用独立 Markdown 文件。
- `name`、`description`、`metadata.type` frontmatter。
- `user`、`feedback`、`project`、`reference` 四种 Memory 类型。
- `feedback`/`project` 的原因和应用范围。
- `MEMORY.md` 作为简短索引，而不是存放完整内容。
- 写入前去重、过期内容更新或删除。
- 不保存代码结构、Git 历史、临时任务和 `CLAUDE.md` 已记录内容。
- Memory 与 plan/task 的职责区分。
- 使用 recalled memory 前验证文件、函数、flag 和外部资源。

Memory 的具体目录仍不硬编码。当前源码的实际目录由
`src/memdir/paths.ts:getAutoMemPath()` 动态计算；本工作树实测为：

```text
/Users/admin/.claude/projects/-Volumes-zhitai-7100-personal-cc-haha/memory/
```

这个值依赖用户、项目根目录和 settings，不能冻结在可复用 Markdown 中。修订版会
在 user context 出现绝对 `.../memory/MEMORY.md` 路径时使用其父目录。

当前修订版为 10,882 字符、1,607 个空白分词。它比捕获首段更长，因为还保留了
适用于当前 `cc-haha` 的 repository、工具真实性和验证规则。

## 15. 推荐用法

### 保留当前 Claude Code 默认提示体系

日常使用首选：

```bash
claude --model claude-opus-4-8
```

这会保留 `getSystemPrompt()` 的动态正文和后续版本更新。

### 只增加规则

如果只是增加团队约束、输出风格或行为规则：

```bash
claude \
  --model claude-opus-4-8 \
  --append-system-prompt-file "/path/to/rules.md"
```

这样默认 Memory、Environment、MCP、Skills 和 session guidance 不会被移除。

### 明确需要完全自定义主正文

可以使用：

```bash
claude \
  --model claude-opus-4-8 \
  --system-prompt-file \
  "/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Opus-4.8替换系统提示词.md"
```

当前替换文件是合法 UTF-8 system prompt，并按照 Opus 4.8 lean system 的主要
职责组织。它是清洗、可移植的重写版，不是捕获文件的逐字副本。

## 16. 一句话结论

`--system-prompt-file` 会替换 `src/constants/prompts.ts:getSystemPrompt()` 生成的
Claude Code coding-agent 默认正文；不会替换 model ID、工具 Schema、Claude Code
API 身份前缀、`CLAUDE.md`、消息附件、权限系统和服务端模型能力。根目录
`claude-opus-4.7.md`/`claude-opus-4.8.md` 虽然格式合法，但属于 Claude.ai；
当前源码最接近 Claude Code Opus 4.7 捕获的 system 首段，目标 Opus 4.8 最接近
Claude Code Opus 4.8 捕获的 lean system 首段，所有完整捕获都需要拆分和清洗。
