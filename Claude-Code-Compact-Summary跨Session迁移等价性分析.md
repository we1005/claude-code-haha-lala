# Claude Code Compact Summary 跨 Session 迁移等价性分析

> 调研日期：2026-08-01
>
> 分析对象：当前 `cc-haha` 源码、Anthropic Claude Code 官方文档，以及用户提供的真实会话 JSONL。
>
> 核心问题：在旧 Session 执行 `/compact` 后，把生成的 Summary 复制到同一项目目录中新开的 Session，是否等价于继续旧 Session？

## 一、结论

**不完全等价。** 更准确地说：

- **只比较模型看到的 Summary 文字时，两者可以非常接近。** 源码最终把内部 Compact Summary 和普通粘贴文字都转换为 Anthropic API 的 `role: "user"` 加文本内容，`isCompactSummary` 等客户端字段不会进入 API 请求。
- **比较完整 Claude Code 会话状态时，两者不等价。** 旧 Session 的 Compact 除了 Summary，还保留或重建 Compact 边界、最近读取文件、计划、Plan Mode、已调用 Skill、工具/MCP 信息、hooks 结果和若干进程内状态。新 Session 粘贴文字不会重建这些状态。
- **消息时序也不等价。** 旧 Session 中 Summary 是压缩后的历史上下文，随后等待下一条用户指令；新 Session 中粘贴的 Summary 本身就是当前用户指令，会立即触发一次回答。
- **同一项目目录只能让两边较容易获得相同的磁盘状态、CLAUDE.md、Auto Memory 和配置，不能复制旧 Session 的运行态。**
- **相同输入也不保证相同输出。** 模型采样、当前文件状态、模型版本、工具连接状态、hooks 输出及动态系统上下文都可能产生差异。

因此，最简短的回答是：

> 把 Summary 复制到新 Session 是一种效果较好的“文字交接”，不是 Claude Code 原生的 Session 延续，也不是状态级克隆。

## 二、先定义“等价”的四个层次

讨论这个问题时，必须区分以下四个层次，否则“看起来一样”和“底层一样”会被混在一起。

| 层次 | 是否接近等价 | 说明 |
| --- | --- | --- |
| Summary 文本语义 | 高度近似 | 若复制完全相同的文字，模型能获得相近的事实性摘要 |
| API 消息角色与正文 | 可以近似 | 两者最终都可成为 `user` 文本，但所在轮次和相邻消息不同 |
| Claude Code harness 状态 | 不等价 | 文件附件、计划、Skills、hooks、工具状态、权限和任务状态不会随文字迁移 |
| 后续输出与执行结果 | 不保证等价 | 模型非确定性和外部状态差异都会影响行为 |

所以，“复制 Summary 是否有用”的答案是肯定的；“是否等价于继续原 Session”的答案是否定的。

## 三、旧 Session 执行 `/compact` 后实际发生了什么

### 3.1 不是简单地把历史替换为一段 Markdown

当前源码的传统完整 Compact 会构造下面这组消息，顺序为：

```text
compact boundary
compact summary
可选的保留消息
post-compact attachments
SessionStart(compact) hook results
```

对应实现见：

- `src/services/compact/compact.ts:330-338`
- `src/services/compact/compact.ts:596-624`
- `src/services/compact/compact.ts:738-748`

其中 Compact Summary 被创建为：

```ts
createUserMessage({
  content: getCompactUserSummaryMessage(...),
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
})
```

也就是说，它在内部确实是一条 `user` 消息，但同时带有两个特殊标记：

- `isCompactSummary: true`：告诉 Claude Code 这是压缩摘要，不是用户键盘输入。
- `isVisibleInTranscriptOnly: true`：控制普通 UI 中的显示方式。

Compact 边界本身则是 `system/compact_boundary`，包含触发方式、压缩前 token 数和逻辑父消息等元数据，见 `src/utils/messages.ts:4530-4554`。

### 3.2 下一次 API 请求只读取最后一个 Compact 边界之后的消息

每次查询开始时，`src/query.ts:366` 调用：

```ts
getMessagesAfterCompactBoundary(messages)
```

`src/utils/messages.ts:4643-4655` 会找到最后一个 Compact 边界，并从该位置开始截取模型可见历史。Compact 边界自身随后作为普通系统记账消息被 API 归一化逻辑过滤，但边界后的 Summary 和附件会继续进入模型上下文。

这解释了 Compact 的核心效果：

- JSONL 中的旧记录仍然存在，可用于 UI、恢复和审计。
- 下一轮模型请求不会自动携带边界以前的完整对话。
- 模型主要依赖 Summary、压缩后保留消息和重新注入内容继续工作。

### 3.3 Compact 后自动恢复的内容

当前源码在 `src/services/compact/compact.ts:517-594` 明确执行了以下动作：

1. 保存压缩前的最近文件读取状态，然后清空旧的 read-file cache。
2. 重新读取并注入最近文件，最多 5 个。
3. 注入异步 Agent 附件。
4. 如果存在计划，注入当前 plan 文件。
5. 如果处于 Plan Mode，重新注入 Plan Mode 指令。
6. 注入当前 Session 已调用过的 Skill 内容。
7. 重新声明 deferred tools、Agent 列表和 MCP 指令。
8. 执行 `SessionStart` 的 `compact` hooks，并把结果加入上下文。

最近文件恢复还有以下预算限制：

- 最多 5 个文件：`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`
- 每个文件最多约 5,000 tokens
- 文件附件总预算约 50,000 tokens

实现位于 `src/services/compact/compact.ts:122-130` 和 `src/services/compact/compact.ts:1415-1463`。

Anthropic 官方文档也明确说明，Compact 后会重新注入项目根 CLAUDE.md、无路径限制的 rules、Auto Memory 和已调用 Skill；嵌套 CLAUDE.md 与 path-scoped rules 则要等再次读取匹配文件后才重新加载：[Explore the context window](https://code.claude.com/docs/en/context-window)。

### 3.4 Compact 会清理一部分状态，但也刻意保留一部分状态

`src/services/compact/postCompactCleanup.ts:31-76` 会清理：

- microcompact 和 context-collapse 的相关缓存
- user context 与 memory file cache
- system prompt sections cache
- classifier approvals
- speculative permission checks
- beta tracing 和 session message cache

但源码明确**不清除已调用 Skill 的内容状态**，以便 Compact 后再次注入。

因此，旧 Session Compact 后并非“全新进程加一段 Summary”，而是“在同一 Session/进程框架中缩短消息历史并有选择地重建上下文”。

## 四、新 Session 粘贴 Summary 时实际发生了什么

### 4.1 它只是普通用户输入

新 Session 中粘贴文本，会走 `src/utils/processUserInput/processTextPrompt.ts:89-99`：

```ts
const userMessage = createUserMessage({
  content: input,
  uuid,
  permissionMode,
  isMeta: isMeta || undefined,
})
```

这里没有设置：

- `isCompactSummary`
- `isVisibleInTranscriptOnly`
- `summarizeMetadata`
- Compact boundary

所以即使文字逐字相同，Claude Code 客户端仍把它当作一条普通的人类消息。它会显示在 UI 中、成为可选择的用户消息，并作为新 Session 的首个任务触发模型回答。

普通粘贴还会经过 `UserPromptSubmit` hooks。`src/utils/processUserInput/processUserInput.ts:178-235` 显示，hook 可以阻止请求、停止继续，或追加 `hook_additional_context`。内部 Compact Summary 是 Compact 流程直接创建的合成消息，不经过这条普通用户提交路径；Compact 流程执行的是 `SessionStart(compact)` 和 PostCompact hooks。两套 hook 的触发源和输出可能不同。

### 4.2 API 层为什么又会“看起来很像”

源码的 API 转换函数 `userMessageToMessageParam()` 位于 `src/services/api/claude.ts:591-633`。它最终只输出：

```json
{
  "role": "user",
  "content": "..."
}
```

`isCompactSummary`、`isVisibleInTranscriptOnly`、UUID、时间戳等客户端字段不会写入 Anthropic Messages API 的消息对象。

因此，如果只孤立比较这一个内容块：

```text
旧 Session 内部 Compact Summary -> API user text
新 Session 普通粘贴文本       -> API user text
```

两者的角色与正文可以相同。这就是复制 Summary 往往能够有效续接任务的原因。

但这不代表完整 API 请求相同，因为 Summary 前后的系统提示、项目上下文、附件、hook 输出、工具定义和消息顺序仍可能不同。

## 五、最容易忽略的差异：消息时序

这是两种操作最直接、也最容易被忽略的区别。

下面首先讨论用户手工运行 `/compact`、Compact 完成后等待下一次输入的场景。自动 Compact、恢复时的 Summary Compact 或主动模式可能设置 `suppressFollowUpQuestions`，此时 `src/services/compact/prompt.ts:357-370` 会在 Summary 后追加“直接继续、不要确认摘要”的指令，旧 Session 可能在同一执行链中直接续跑。这种情况与新 Session 手工粘贴的差异更大。

### 旧 Session

```text
[Compact Summary，作为压缩后的历史]
[Compact 自动重注入的附件和 hooks]
[等待用户下一条真实指令]
```

### 新 Session 直接粘贴

```text
[新 Session 启动上下文]
[用户当前消息 = Compact Summary]
[立即要求模型对这条消息作答]
```

所以把 Summary 单独粘贴后，新 Session 可能会：

- 回答“收到”或重新概括摘要。
- 按 Summary 的 `Optional Next Step` 自动继续。
- 因为 Summary 写着“等待用户下一条指令”而选择等待。
- 把摘要中用于描述旧状态的文字误认为当前仍然有效。

要让行为更接近原 Session，应把 Summary 与新的真实任务一起发送，并明确 Summary 只是只读交接上下文。例如：

```text
以下内容是上一 Session 的只读交接摘要，不是新的任务。
不要自动执行其中的 Optional Next Step；先以磁盘、git status 和当前配置核对其时效性。

<handoff_context>
...原 Summary 或精简后的交接内容...
</handoff_context>

当前任务：继续批量下载我接下来提供的这些公众号 URL，并先确认现有下载器文件和依赖仍然存在。
```

这仍不是状态级等价，但比“只粘贴 Summary”更接近原 Session 的下一轮结构。

## 六、同一个项目目录能统一什么，不能统一什么

### 6.1 能够统一或大概率统一的部分

如果新旧 Session 使用相同项目目录、相同二进制版本、相同启动参数和相同模型，则两边通常能够获得：

- 相同的当前工作目录和仓库文件。
- 相同的项目根 CLAUDE.md、rules 和 Auto Memory。
- 相同的常规 settings 文件。
- 相同的项目级 Skills、Plugins 和 MCP 配置来源。
- 相近的系统提示与工具定义。

官方文档明确指出，每个新 Session 都从全新的 context window 开始；跨 Session 自动共享的主要机制是 CLAUDE.md 和 Auto Memory，而不是旧对话历史：[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)、[How Claude remembers your project](https://code.claude.com/docs/en/memory)。

### 6.2 不能通过相同目录复制的部分

单纯在同一目录启动新 Session，不会自动复制：

- 旧 Session 的消息树和 Compact boundary。
- 最近读取的最多 5 个文件附件。
- 当前计划及 Plan Mode 附件。
- 旧 Session 已调用 Skill 的完整正文状态。
- 旧 Session 内已发现的 deferred tool 状态。
- `SessionStart(compact)` hook 输出。
- “Allow for this session”之类的进程内授权。
- 当前前台/后台 Agent、Bash 进程和任务的运行态。
- 文件 checkpoint、attribution、readFileState 等会话状态。
- 旧 Session 的 cost/usage 统计和会话身份元数据。

新 Session 还可能因为以下因素获得不同上下文：

- 启动时 git status、branch 和 recent commits 已变化。
- MCP Server 的连接成功情况不同。
- 启动参数不同，如 `--model`、`--agent`、`--system-prompt-file`、`--append-system-prompt`、`--mcp-config`、`--add-dir`。
- settings、CLAUDE.md、Auto Memory 或插件在两次启动之间发生变化。
- Claude Code 已升级，系统提示和工具 Schema 随版本改变。

官方 Session 文档还指出，即使执行原生 Resume，也不是所有启动参数都会恢复；`--mcp-config`、`--settings`、`--plugin-dir`、`--fallback-model` 和 `--add-dir` 等可能需要再次传入：[Manage sessions](https://code.claude.com/docs/en/sessions)。

## 七、真实 JSONL 实证结果

用户提供的会话文件是：

```text
/Users/admin/.claude/projects/-Volumes-zhitai-7100-zhihu-zhida-api/7d14919c-8e0e-4d63-b263-dad4bc0ab5d0.jsonl
```

只读检查得到：

| 项目 | 实测结果 |
| --- | ---: |
| JSONL 行数 | 8,565 |
| 文件字节数 | 72,896,308 bytes |
| Compact boundary 数量 | 5 |
| `isCompactSummary: true` 数量 | 5 |
| Session ID 数量 | 1 |
| 用户给出的最后一份 Summary 长度 | 8,713 字符 |
| 最后一份 Summary 所在行 | 8,555 |

最后一次 Compact 在 JSONL 中的相邻结构为：

```text
system / compact_boundary
user / isCompactSummary=true / isVisibleInTranscriptOnly=true
user / local-command caveat
user / /compact command marker
user / "Compacted ..." command output
...
```

这证明了两点：

1. 执行多次 Compact 并没有更换 Session ID，仍在同一个会话身份下延续。
2. Summary 在 JSONL 中不是普通粘贴消息，而是一条带特殊字段、挂在 Compact boundary 后的合成 user message。

## 八、对这份真实 Summary 的具体审计

### 8.1 它作为交接摘要的优点

这份 Summary 的信息密度很高，包含：

- 当前主任务和按时间排序的历史任务。
- 精确文件路径、类名、函数名和关键代码片段。
- 已遇到的错误、修复方法和真实执行输出。
- 用户原始消息、完成项、待办项和 Optional Next Step。
- 原 JSONL 的绝对路径，方便按需回查。

对“继续微信公众号下载器工作”而言，它足以让新 Session 快速理解大部分任务语义。

### 8.2 它包含已经过期的动态状态

以下内容在新 Session 中不能直接当作当前事实：

- “`/context` 已经 82%”只描述旧 Session；新 Session 的 context 使用量从较低水平重新开始。
- “等待用户提供 URL 列表”只描述生成 Summary 时的最后状态；用户粘贴 Summary 本身并不必然要求继续等待。
- 文件、依赖、下载结果、git 状态和网络可访问性都可能已变化。
- 原会话中的后台进程、权限批准和 task 状态不会由这段文字恢复。
- Summary 中的测试成功记录只是历史证据，不是新 Session 启动时重新验证的结果。

其中“旧 Session 82%，新 Session 并非 82%”本身就是两种方式不可能完全等价的直接反例。

### 8.3 它对当前 WeChat 任务而言过于宽泛

这份 Summary 同时带入了：

- 已完成且已停止的 btsow 分析。
- 成人内容、magnet 和拒绝历史。
- 其他已完成的站点逆向项目。
- 用户当时的情绪化原话。
- 与当前下载器维护无关的 ethics clause removal 等记录。

这些文字都会成为新 Session 当前模型可读的上下文。模型不会形成类似人的长期“戒心”，但会根据当前请求内所有相关文字判断任务边界、风险和下一步。因此，不相关的历史可能造成：

- 注意力被旧任务分散。
- 对新请求的意图判断更谨慎。
- Summary 占用更多上下文。
- 错误地恢复已经终止的任务线。

如果新 Session 只用于微信公众号文章下载，应把交接内容精简为：

- 当前合法目标。
- 当前代码和文件状态。
- 已验证命令与结果。
- 仍需完成的步骤。
- 需要重新核实的假设。

这属于上下文质量和隐私最小化，不会改变某个请求本身是否允许执行。

### 8.4 原 JSONL 路径不会被自动读取或自动 grep

Summary 尾部明确写着：

```text
If you need specific details ... read the full transcript at: <path>
```

这是一条给模型的按需回查建议，不是 Claude Code 自动恢复完整 JSONL 的指令。

当前项目权限逻辑 `src/utils/permissions/filesystem.ts:284-290` 和 `src/utils/permissions/filesystem.ts:1631-1641` 允许读取当前项目对应的 `~/.claude/projects/<project>/...` 内部目录。因此，在同一项目目录中新开的 Session 通常能够按需读取这条旧 transcript 路径。

但是：

- 新 Session 不会启动后自动把整个 72.9 MB 文件塞进上下文。
- 没有证据表明它会自动对 JSONL 做相似性搜索。
- 只有模型判断确实需要细节并主动调用 Read/Grep 等工具时，才会访问该文件。
- 读取旧 JSONL 后获得的只是文本证据，仍不会恢复旧进程的运行态。

## 九、Session ID 与服务端是否构成“隐藏记忆”

当前源码会把 Session ID 发送到 API：

- 请求 metadata 的 `user_id` JSON 中包含 `session_id`：`src/services/api/claude.ts:506-530`
- HTTP header 包含 `X-Claude-Code-Session-Id`：`src/services/api/client.ts:155-163`

旧 Session Compact 后保持旧 ID，新 Session 则使用新 ID。

但源码和官方文档都没有证据表明 Anthropic 模型会依据该 ID 自动取回旧对话，形成脱离当前请求内容的“隐藏语义记忆”。官方文档明确说明，模型在 API 请求之间不会自行记住内容，Claude Code 会在每轮重发系统提示、项目上下文和消息历史：[Prompt caching](https://code.claude.com/docs/en/prompt-caching)。

因此应把 Session ID 理解为会话归档、路由、诊断、统计和产品功能所需的标识，不应把它理解为“只要 ID 相同，服务端就会补齐 Summary 遗漏内容”。

同理，新 Session 换了 ID，也不会抹去你主动粘贴进当前请求的旧历史文字。

## 十、Prompt Cache 也不是语义记忆

Prompt caching 只复用相同请求前缀的计算结果，用于降低延迟和成本；它不会把未发送的旧对话补进新 Session。

对这两种方式而言：

- Compact 会用 Summary 替换消息历史，因此会重建 conversation-layer cache。
- 同目录、同模型的新 Session 可能命中相同的系统提示/项目上下文前缀缓存。
- 如果启动时 git status 或系统提示不同，前缀就会不同。
- 原生 fork 能精确继承父会话的系统提示、工具和消息历史，因此更容易直接命中父会话缓存。

官方文档对此有明确说明：[How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)。

缓存是否命中可能影响首轮速度和成本，但不应被当作“上下文是否等价”的判据。

## 十一、哪种方式最接近你的目标

| 目标 | 推荐方式 | 等价程度 |
| --- | --- | --- |
| 原地继续工作 | 在 Compact 后的原 Session 直接继续 | 最高 |
| 退出后继续同一会话 | `claude --resume <session-id>` | 很高，但需注意启动参数和不可恢复状态 |
| 新 ID，同时完整继承当前历史 | 原 Session 内执行 `/branch <name>` | 高，且同进程授权/后台任务可延续 |
| 退出后复制为新 ID | `claude --resume <session-id> --fork-session` | 高，但新进程不继承进程内授权和后台任务 |
| 只迁移必要事实 | 新 Session 加精简 handoff | 语义高、运行态低，适合切换任务或清理噪声 |
| 把完整 Summary 当普通提示粘贴 | 可用，但需加当前任务和时效性声明 | 中等 |

Anthropic 官方文档对原生分支的定义是：复制截至分支点的 conversation history，创建新的 Session ID，并保持原 Session 不变。`/branch` 在同一进程中还会携带当前 Session 授权；`--fork-session` 是新进程，不继承这种进程内授权：[Manage sessions](https://code.claude.com/docs/en/sessions)。

当前源码也印证了这一点：

- `src/utils/sessionBranching.ts:462-536` 创建新 UUID、复制 transcript 消息、重连 parent UUID，并记录 `forkedFrom`。
- `src/utils/sessionRestore.ts:435-462` 区分复用原 Session ID 与 `--fork-session` 保留新 ID。

### 针对这份真实会话的命令

继续原会话：

```bash
claude --resume 7d14919c-8e0e-4d63-b263-dad4bc0ab5d0
```

复制历史但使用新 Session ID：

```bash
claude \
  --resume 7d14919c-8e0e-4d63-b263-dad4bc0ab5d0 \
  --fork-session
```

如果原 Session 仍在当前终端中运行，优先使用：

```text
/branch wechat-mp-followup
```

这三种方式都比手工复制 Summary 更接近 Claude Code 原生会话语义。

## 十二、推荐的精简交接格式

如果你明确想开一个干净的新 Session，而不是 fork 旧历史，建议不要逐字粘贴整个 8,713 字符 Summary。可以使用下面的任务交接包：

```markdown
# 上一 Session 交接上下文

## 当前目标
维护并批量运行微信公众号文章下载器，仅处理用户提供且有权保存的文章 URL。

## 当前实现
- 项目：`/Volumes/zhitai-7100/zhihu-zhida-api/wechat-mp-reverse`
- 主脚本：`scripts/wechat_mp_downloader.py`
- 支持单 URL、`--file` 批量输入、输出目录、间隔、UA 与 Cookie。
- 已验证 URL：`https://mp.weixin.qq.com/s/3qwqzo4LOomvCtQM1rlsBg`
- 历史验证结果：成功生成 Markdown、HTML，并下载 3 张图片。

## 重要实现细节
- 正文：`#js_content`
- 图片：`data-src`，CDN 为 `mmbiz.qpic.cn`
- 异常：`ArticleGone`、`VerifyChallenge`、`MpError`
- `html2text` 安装在用户 Python 环境；需要重新检查当前解释器能否导入。

## 当前待办
1. 接收用户提供的一行一个的 URL 列表。
2. 先检查 `git status --short`、脚本存在性和依赖。
3. 用一条 URL 做 smoke test，再批量运行。

## 必须重新核实
- 不把旧 Summary 中的 git 状态、依赖和运行结果当作当前事实。
- 不自动恢复已结束或无关的 btsow 等历史任务。
- 如需精确旧错误，再按需读取原 transcript。
```

发送给新 Session 时，在末尾追加当前指令：

```text
以上仅为只读交接上下文。当前任务：先核对现有文件和 git 状态，然后处理下面这些 URL：...
```

## 十三、如何做可重复的对照实验

如果需要自己验证，可以用一个无风险、可重复的小任务比较两条路径。

### 路径 A：原 Compact Session

1. 在旧 Session 执行 `/compact`。
2. 执行 `/context`，记录各类上下文占用。
3. 提问：“只列出你当前能看到的交接信息来源，不读取任何新文件。”
4. 再要求列出当前 plan、已加载 Skill 和最近恢复的文件。

### 路径 B：新 Session 粘贴 Summary

1. 在相同目录执行新的 `claude`。
2. 使用与 A 相同的模型和启动参数。
3. 粘贴完全相同 Summary，并追加与 A 相同的问题。
4. 执行 `/context`，比较 system、memory、tools 和 messages 分类。

### 应检查的本地证据

不要只比较两次自然语言回答，还应检查：

- 两个 JSONL 中 Summary 是否分别带有 `isCompactSummary`。
- 两个 Session ID 是否不同。
- `/context` 的文件、Skills、MCP 和 message token 分类。
- 是否存在 plan attachment 和 Compact hook output。
- 两边的模型、Claude Code 版本、启动参数与 git status 是否一致。

即使所有可控条件都相同，也不应以逐字输出相同作为成功标准。更合理的标准是：是否正确掌握当前目标、关键文件、已验证事实、未完成项和约束。

## 十四、最终判断

对用户给出的具体场景，可以作出以下最终判断：

1. **复制这份 Summary 到同目录新 Session，足以迁移大部分显式任务事实。**
2. **它不会迁移旧 Session 的完整 Claude Code 状态，因此不等价于继续旧 Compact Session。**
3. **这份 Summary 本身过宽，并包含动态过期信息和多个已结束任务；用于 WeChat 后续工作时应精简。**
4. **Summary 中的旧 JSONL 路径可以帮助按需回查，但 Claude Code 不会自动扫描或恢复整个 JSONL。**
5. **需要原生分支时使用 `/branch` 或 `--fork-session`；需要原地连续性时使用 `--resume`；需要干净交接时使用精简 handoff。**
6. **即使 Summary 文字完全相同，也只能说模型可见文字近似，不能说请求结构、运行态和输出效果严格相同。**

## 十五、证据索引

### 当前仓库源码

- `src/services/compact/compact.ts:122-130`：Compact 后文件与 Skill 预算。
- `src/services/compact/compact.ts:330-338`：Compact 后消息组合顺序。
- `src/services/compact/compact.ts:517-624`：恢复文件、plan、Skills、tools、MCP、hooks，并创建特殊 Summary。
- `src/services/compact/compact.ts:1415-1463`：最近文件附件恢复逻辑。
- `src/services/compact/postCompactCleanup.ts:31-76`：Compact 后清理和刻意保留的状态。
- `src/utils/messages.ts:460-518`：用户消息内部字段。
- `src/utils/messages.ts:4530-4655`：Compact boundary 与边界后消息截取。
- `src/utils/processUserInput/processTextPrompt.ts:89-99`：普通粘贴文本的消息创建方式。
- `src/utils/processUserInput/processUserInput.ts:178-235`：普通输入触发 `UserPromptSubmit` hooks。
- `src/services/compact/prompt.ts:337-373`：Summary 包装、transcript 路径和自动续跑指令。
- `src/query.ts:366`、`src/query.ts:660-665`：边界截取和 API 查询输入。
- `src/services/api/claude.ts:591-633`：内部 user message 转为 API `role/content`。
- `src/services/api/claude.ts:506-530`、`src/services/api/client.ts:155-163`：请求中的 Session ID。
- `src/utils/sessionBranching.ts:462-536`：原生 branch 复制 transcript 并创建新 ID。
- `src/utils/sessionRestore.ts:435-462`：resume 与 fork 的 Session ID 行为。
- `src/utils/permissions/filesystem.ts:284-290`、`src/utils/permissions/filesystem.ts:1631-1641`：当前项目内部历史文件的读取权限。

### Anthropic 官方文档

- [Explore the context window](https://code.claude.com/docs/en/context-window)
- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)

> 注意：JSONL entry 格式属于 Claude Code 内部实现，官方文档说明其可能随版本变化。长期自动化应优先使用 `/export`、`--output-format json` 或官方 Session 接口，而不是依赖固定 JSONL 字段。
