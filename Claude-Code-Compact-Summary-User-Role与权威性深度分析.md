# Claude Code Compact Summary 的 User Role 与实际权威性深度分析

> 分析对象：当前 `cc-haha` 源码、用户提供的真实 Claude Code Session JSONL、Anthropic 截至 2026-08-01 的公开文档、公开 Issue 和相关研究。
>
> 核心问题：Compact Summary 到达 Anthropic API 时是否只是 `role: "user"`？即使 role 相同，它是否仍比用户手工输入具有更高地位或更强影响？

## 一、结论先行

### 1.1 对“Cloud API 眼里它是什么”的直接回答

对当前 `cc-haha` 实现，答案是明确的：

- Compact Summary 在**生成阶段**由一次独立的总结请求产生；这次请求有总结任务自己的提示词。
- Summary 生成完毕并回灌主会话后，被创建为 `UserMessage`，内部 `message.role` 是 `user`。
- 发往 Anthropic Messages API 时，它仍被转换为 `role: "user"` 加文本内容。
- `isCompactSummary: true`、`isVisibleInTranscriptOnly: true`、本地 UUID 等标记不会进入 API 的 `messages` 对象。
- 当前源码没有把它放进顶层 `system`，也没有使用较新的 mid-conversation `role: "system"`。
- 当前源码也没有使用 Anthropic 新版 server-side compaction 的 `compact_20260112` / `compaction` block 来承载这份 Summary。

因此，从 Anthropic Messages API 的**请求协议和角色优先级**看，这份 Summary 不是系统消息，也没有比普通用户消息更高的指令权限。

### 1.2 你的直觉“一半正确”

你觉得 Compact Summary 比人工输入“更有影响”，这个体感完全可能出现，但原因不是它具有隐藏的 system role，而是：

1. Compact 会删除旧的原始对话，Summary 成为模型了解过去的主要甚至唯一文本来源。
2. Summary 有固定的框架包装，明确声称它是上一段会话的结构化延续摘要。
3. Claude Code 的系统提示本身告诉模型，会话会自动被压缩；模型因而能从文字语义上识别这是一份框架生成的交接上下文。
4. Summary 通常高度结构化，包含任务、文件、错误、用户要求和下一步，比一段随意粘贴的文字更容易被模型采用。
5. Compact 后还会重新注入 CLAUDE.md、Memory、Skills 和附件等上下文，它并非孤立出现。

所以必须把两个概念分开：

| 维度 | Compact Summary 的实际情况 |
| --- | --- |
| API role | `user` |
| 指令优先级 | 用户层级，不能覆盖 `system` |
| 客户端内部地位 | 特殊合成消息，用于恢复、渲染和会话记账 |
| 对历史事实的影响 | 往往很强，因为被删掉的旧历史只能由它代表 |
| 与人工粘贴是否严格等价 | 只有在完整请求也相同时才可视为模型输入等价；一般新 Session 并不满足 |

一句话概括：

> Compact Summary 没有更高的**协议权威性**，但经常拥有更大的**上下文支配力**。

## 二、最容易混淆的两个 API 调用

Compact 不是“把一段高权限 Summary 直接塞回原请求”这么简单。源码里至少存在两个逻辑上独立的模型调用。

### 2.1 调用 A：生成 Summary

`src/services/compact/compact.ts:400-459` 的流程是：

1. 执行 `PreCompact` hooks。
2. 通过 `getCompactPrompt(customInstructions)` 生成总结指令。
3. 将总结指令包装成一个 `createUserMessage()`。
4. 把原对话和这条总结请求交给 `streamCompactSummary()`。
5. 从 Claude 的 assistant 响应中提取 Summary 文本。

关键代码为：

```ts
const compactPrompt = getCompactPrompt(customInstructions)
const summaryRequest = createUserMessage({
  content: compactPrompt,
})

summaryResponse = await streamCompactSummary({
  messages: messagesToSummarize,
  summaryRequest,
  // ...
})
```

默认的 fork 路径会复用主会话的 system、tools、model 和历史前缀；fallback 路径在 `src/services/compact/compact.ts:1292-1322` 明确设置：

```ts
systemPrompt: asSystemPrompt([
  'You are a helpful AI assistant tasked with summarizing conversations.',
]),
thinkingConfig: { type: 'disabled' },
querySource: 'compact',
```

Anthropic 官方也说明，Claude Code 为生成 Summary 会发送一次独立请求，沿用会话的 system、tools 和 history，并在末尾追加一条 user summarization instruction：[Claude Code prompt caching 文档](https://code.claude.com/docs/en/prompt-caching)。

这里确实存在“总结器的 system prompt”，但它只负责**指导 Claude 如何生成摘要**。它不会让生成出来的文字永久继承 system role。

可以类比为：一名编辑依据高优先级编辑规范写出一份报告，不代表这份报告随后自动获得编辑规范本身的权限级别。

### 2.2 调用 B：主 Agent 在 Compact 后继续工作

Summary 生成后，`src/services/compact/compact.ts:613-624` 将其重新创建为：

```ts
createUserMessage({
  content: getCompactUserSummaryMessage(...),
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
})
```

`src/utils/messages.ts:460-518` 中的 `createUserMessage()` 会构造：

```ts
{
  type: 'user',
  message: {
    role: 'user',
    content,
  },
  // 客户端字段在外层
  isCompactSummary,
  isVisibleInTranscriptOnly,
}
```

这是 Summary 在主 Agent 会话里的角色。不要把调用 A 的 summarizer system prompt 错当成调用 B 中 Summary 自身的 role。

## 三、从内存对象到真实 HTTP Body 的完整证据链

### 3.1 Compact boundary 不是发给模型的 system message

Compact 完成后，本地消息历史还包含 `compact_boundary`。`src/query.ts:366` 先执行：

```ts
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

`src/utils/messages.ts:4641-4655` 明确说明：boundary 自身虽然是本地 `system` 消息，但会在 `normalizeMessagesForAPI()` 中被过滤。它是会话切片和恢复的记账标记，不是给 Summary 提权的 API system message。

### 3.2 项目上下文也可能以 user 内容出现

在调用模型前，`src/query.ts:660-665` 还会调用：

```ts
messages: prependUserContext(messagesForQuery, userContext)
```

`src/utils/api.ts:449-473` 将 user context 包装成带 `<system-reminder>` 标签的 `createUserMessage()`。也就是说，Claude Code 中有些由应用自动注入的内容在 API role 上同样是 `user`，但模型可以依据 XML 标签、固定措辞和 system prompt 中的说明理解其来源。

这再次说明：

> API role 是权限通道；内容来源、语义标签和应用层用途是另一组信息。两者不能简单画等号。

### 3.3 连续 user 消息会被合并

`src/utils/messages.ts:2094-2199` 明确写道，连续 user 消息会被合并，因为 Anthropic 1P API 本身也把连续 user 消息视为同一个 user turn，而 Bedrock 需要客户端预先兼容。

`mergeUserMessages()` 位于 `src/utils/messages.ts:2411-2448`，它把内容块按顺序连接。

因此，Compact 后第一次真正向主 Agent 发请求时，模型看到的结构通常更接近：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "<system-reminder>...项目上下文...</system-reminder>" },
    { "type": "text", "text": "This session is being continued...\n\nSummary: ..." },
    { "type": "text", "text": "...恢复的附件、Skill 或其他 user context..." },
    { "type": "text", "text": "用户 Compact 后新输入的真实指令" }
  ]
}
```

具体内容块会随会话状态改变，但关键点不变：Summary 与下一条人工消息可能连在**同一个 API user turn** 中，而不是分别拥有不同权限。

这还意味着人工最新指令通常位于 Summary 之后。不能假设 Summary 天然压过后面的人工纠正；相反，清晰、靠后的当前任务往往更有即时显著性。Anthropic 的 prompt 指南也建议在长上下文任务中清晰组织内容并把查询放在相关材料之后：[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)。

### 3.4 API 转换会丢弃 Compact 专用字段

最终转换函数位于 `src/services/api/claude.ts:591-633`：

```ts
export function userMessageToMessageParam(message: UserMessage): MessageParam {
  return {
    role: 'user',
    content: message.message.content,
  }
}
```

启用 prompt caching 时，最后一个 content block 可能多一个 `cache_control`，但它只控制缓存，不改变指令权威性。

`src/services/api/claude.ts:1764-1793` 构造最终参数：

```ts
{
  model,
  messages: addCacheBreakpoints(messagesForAPI, ...),
  system,
  tools,
  metadata,
  max_tokens,
  thinking,
  // ...
}
```

`src/services/api/claude.ts:1887-1897` 最终调用：

```ts
anthropic.beta.messages.create(
  { ...params, stream: true },
  { signal, headers },
)
```

在这条转换链中没有：

- `isCompactSummary`
- `isVisibleInTranscriptOnly`
- `compact_summary: true`
- Summary 专属 role
- Summary 专属 beta header
- Summary 专属 metadata 字段

对 `src/` 的全量检索显示，`isCompactSummary` 只用于 UI、恢复、SDK replay、分支、Session 存储、消息过滤和 Compact 流程；`src/services/api/claude.ts` 没有根据它改变请求。

## 四、请求头能否让云端“偷偷知道这是 Summary”

当前客户端确实会发送一些产品和会话标识。`src/services/api/client.ts:138-166` 包括：

```text
x-app: cli
User-Agent: ...
X-Claude-Code-Session-Id: ...
```

OAuth、设备和账户 metadata 也可能随请求发送。这些足以让服务端知道请求来自 Claude Code，并用于认证、路由、限额、日志和诊断。

但在当前源码中：

- `querySource: 'compact'` 用于**生成 Summary 的那次独立调用**及客户端日志/缓存策略。
- `buildFetch()` 只把 `source` 写入本地调试日志，没有把它作为 HTTP header 注入。
- Compact 后的正常主 Agent 请求使用正常主线程 query source，而不是一条 Summary 权限标志。
- Session ID 只能标识会话；它本身没有告诉服务端当前哪一个 user content block 是 Compact Summary。

Anthropic 官方说明 Messages API 是 stateless，调用方每次必须重发完整历史：[Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)。官方 prompt caching 文档同样说明，模型不会在请求之间自行记住历史，Claude Code 每轮重新发送 system、项目上下文和对话消息。

因此，最严谨的说法是：

> 公开协议与当前客户端源码都没有 Summary 专属的服务端提权信号。无法从闭源服务端外部证明“不存在任何未公开实验”，但目前没有证据支持 Anthropic 根据 Session ID 对这段 user 文本施加隐藏 system 权重。

若两次请求的 model、system、tools、messages、content 顺序及其他模型参数完全相同，那么仅从模型输入看，“内部生成后回灌的 Summary”和“人工构造的同字节文本”没有可见的来源差异。输出仍可能因采样和服务端正常运行差异而不同，这不等于存在 Summary 权重。

## 五、Anthropic 官方对 user 与 system 优先级的定义

### 5.1 Opus 4.6 和 Opus 4.7 是否支持

截至 2026-08-01，Anthropic 官方列出的 mid-conversation system message 支持范围是：

| 模型 | `messages` 中途使用 `role: "system"` |
| --- | --- |
| Claude Opus 4.6 | **不支持** |
| Claude Opus 4.7 | **不支持** |
| Claude Opus 4.8 | 支持 |
| Claude Opus 5 | 支持 |
| Claude Fable 5 | 支持 |
| Claude Mythos 5 | 支持 |
| Claude Sonnet 5 | **不支持**，官方要求继续使用顶层 `system` |

官方页面写得很明确：该功能可用于 Fable 5、Mythos 5、Opus 4.8 和 Opus 5，并明确说明 Sonnet 5 不支持；Opus 4.6、Opus 4.7 也不在支持列表中。参见 [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)。

Anthropic 的 [2026-05-28 Platform release notes](https://platform.claude.com/docs/en/release-notes/overview) 还把它列为随 Opus 4.8 发布的新能力；[Opus 4.8 prompting 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8) 也把 mid-conversation system messages 列入相对 Opus 4.7 的 API 行为变化。这两条时间线进一步说明 Opus 4.7 和 4.6 不具备该请求能力。

但这不表示 Opus 4.6 和 4.7 “没有系统提示词”。二者一直支持请求最外层的顶级 `system` 字段：

```json
{
  "model": "claude-opus-4-7",
  "system": "你是一个 Coding Agent……",
  "messages": [
    { "role": "user", "content": "修复这个测试" }
  ]
}
```

它们缺少的是下面这种**插入对话历史中间**的 system turn：

```json
{
  "model": "claude-opus-4-8",
  "system": "会话全程适用的基础规则",
  "messages": [
    { "role": "user", "content": "开始检查仓库" },
    { "role": "assistant", "content": "我先读取状态。" },
    { "role": "user", "content": "现在进入只读审计模式" },
    { "role": "system", "content": "从现在开始禁止修改文件。" }
  ]
}
```

因此，在 Opus 4.6/4.7 上，Coding Agent 若要中途改变 operator 指令，只能选择：

- 修改下一次请求的顶层 `system`，代价是改变整个 prompt prefix，通常导致缓存失效。
- 把动态说明作为普通 `user` 内容发送，代价是只有 user 权限。
- 开新会话，以新的顶层 `system` 启动。

不能仅靠把 `model` 改为 `claude-opus-4-7`，再在 `messages` 中塞入 `role: "system"`，就假设服务端会接受。按照当前官方契约，该请求形状不受这些旧模型支持；实现方应在发送前按模型能力拒绝或降级，而不是依赖未声明行为。

### 5.2 中途 system 的权威性究竟多高

官方文档明确区分：

- `user`：来自最终用户的请求。
- `system`：来自应用操作者的事实和约束。
- 冲突时 system 优先于 user。
- mid-conversation system 保持 system/operator 权限，不会降格为普通 user 内容。
- 对后续 turns 而言，较晚的 mid-conversation system 可以更新较早的 system 指令；官方甚至说明冲突时它可以优先于顶层 `system` 中的旧指令。

所以“权威性等同顶层 system”基本正确，但更精确的表述是：

> 它属于同一个 system/operator 权限层，并从插入位置开始生效；在后续上下文中，较新的 system 指令可以更新较旧的顶层或中途 system 指令。

它不是无限权限。模型自身训练、安全机制、API safeguards、工具权限和服务端策略仍可约束 system 内容。

### 5.3 这是不是 Claude Code 专属机制

**不是。** 这是 Anthropic Messages API 的通用请求能力，不是 Claude Code 私有提示词技巧，也不要求调用方必须是 Claude Code。

官方当前声明它可用于：

- Anthropic Claude API。
- Claude in Amazon Bedrock 的 Messages API。
- Google Cloud 上相应的 Claude Messages API。

当前功能页面没有把 Microsoft Foundry 列入这项能力的可用 Provider，因此不应仅因为 Opus 4.8 本身在 Foundry 可用，就推断 Foundry 一定接受中途 system turn；应以 Foundry 的实际请求契约或一次脱敏 request-shape 测试为准。

mid-conversation system message 本身已经 general availability，**不需要 beta header**。不要把它与同一页面上的 mid-conversation tool changes 混淆；后者仍需要 `mid-conversation-tool-changes-2026-07-01` beta header。

任意 Coding Agent，包括自研 Agent、OpenCode 类工具、IDE 插件或服务器 Agent，只要同时满足以下条件，就可以使用相同机制：

1. 实际请求的是 Fable 5、Mythos 5、Opus 4.8 或 Opus 5。
2. 通过官方明确支持该能力的 Messages API/Provider，而不是一个会丢弃或改写 role 的兼容代理。
3. Agent 的内部消息模型允许 `system` turn，而不只允许 `user | assistant`。
4. Agent 最终真的在 `messages` 数组里发出 `{ "role": "system" }`，没有在归一化阶段把它过滤或改写成 user。
5. 消息位置符合官方规则。

换句话说：

> 选择 Opus 4.8 只提供了服务端能力；是否实际使用这项能力，取决于 Coding Agent 的 harness 和请求构造。

一个第三方 Agent 即使使用 Opus 4.8，如果它始终只发送顶层 `system` 加 `user/assistant` 历史，那么会话中就不会凭空出现 mid-conversation system。反过来，一个实现正确的非 Claude Code Agent 可以直接使用它，权威性不会因为客户端名字不是 Claude Code 而降低。

订阅登录方式也不是决定因素。Claude Team/Max OAuth、API key 或云 Provider 影响认证、可用模型、配额和路由；mid-conversation system 是否生效，核心仍是**目标模型、实际 API surface 和最终请求形状**。第三方网关或 OpenAI-compatible API 可能把 system role 合并到顶层 system、转成 user，甚至直接拒绝，因此必须检查该网关的实际转译结果。

这也不能反向推出“任何第三方 Coding Agent 都可以自由复用 Claude Code 的订阅 OAuth 凭证”。模型/API 的消息能力与 OAuth 客户端授权、产品使用条款是两件事；第三方 Agent 仍须通过 Anthropic 允许的认证路径取得模型访问权。mid-conversation system 不会绕过认证或订阅授权限制。

### 5.4 官方位置限制

即使模型受支持，也不能把 system turn 随意插入任何位置。官方当前要求：

- 不能成为 `messages` 的第一条；第一条之前的全局规则应放顶层 `system`。
- 必须紧跟一个 user turn，或紧跟一个以 server tool result 结束的 assistant turn。
- 它必须是 `messages` 最后一条，或者下一条立即是 assistant turn。
- 不能插在 assistant `tool_use` 与对应 user `tool_result` 之间。
- 连续 system messages 可以接受，并被视作同一个 system section。

违反这些位置要求会得到 API 请求错误。这说明它是正式的消息协议结构，不是任意 XML 标签或 Markdown 文本模拟出来的“伪 system”。

### 5.5 当前 cc-haha 为什么不能直接用

当前仓库即使把模型 ID 改成 Opus 4.8，也没有自动实现 mid-conversation system，源码证据包括：

1. `src/utils/messages.ts:2056-2074` 的 `normalizeMessagesForAPI()` 结果类型只有 `UserMessage | AssistantMessage`。
2. 除 `local_command` 外，本地 `type: "system"` 消息在 API 归一化前会被过滤。
3. `local_command` 虽然是本地 system message，但 `src/utils/messages.ts:2078-2092` 会明确将其转换成 `createUserMessage()`。
4. `src/services/api/claude.ts:3131-3176` 最终只调用 user 和 assistant 两个转换函数。
5. 仓库当前使用 `@anthropic-ai/sdk@0.80.0`；其 `BetaMessageParam.role` 类型仍是 `'user' | 'assistant'`。

作为对照，检查当前公开的 `@anthropic-ai/sdk@0.115.0` 包，其普通和 beta `MessageParam.role` 已更新为：

```ts
role: 'user' | 'assistant' | 'system'
```

因此若要在 cc-haha 中正式适配，至少需要：

- 升级或兼容支持 system message role 的 Anthropic SDK。
- 给 model capability 增加明确的 `supportsMidConversationSystem` 判断。
- 扩展内部 model-facing message 类型，不能与仅用于 UI/记账的本地 `SystemMessage` 混用。
- 修改 `normalizeMessagesForAPI()`，按严格位置规则保留真正的 API system turn。
- 修改 `addCacheBreakpoints()` 和最终转换逻辑，支持第三种 role。
- 针对 Claude API、Bedrock、Google Cloud 和第三方代理分别做 request-shape 测试。
- 在 Opus 4.6、Opus 4.7、Sonnet 5 等不支持模型上提前拒绝或使用明确降级策略。

仅升级 SDK 仍然不够；SDK 只让 TypeScript 能表达这个对象，不会自动把 cc-haha 的本地 system 记账消息变成 API system turn。

还应继续坚持本文前面的结论：即便未来 cc-haha 支持 mid-conversation system，也**不应把完整 Compact Summary 无条件提升为 system**。Summary 混合了用户输入、文件、网页、工具结果和模型转述；整体提权会放大 prompt injection、错误归因和过期状态风险。更合理的做法是继续把 Summary 当 conversation state，只把少量由应用自己产生、来源可信且确实需要 operator 权限的动态约束放进 mid-conversation system。

这个官方能力也构成了很强的反证：如果新版 cc-haha 想让 Compact Summary 获得 system 权威，它有一种明确的 API 表达方式；但当前代码没有使用它，而是明确发送 `role: "user"`。

## 六、为什么同为 user，实际影响仍然可能不同

LLM 没有公开的、可以简单写成“user 权重 = 1，summary 权重 = 1.5”的数值规则。role 决定冲突时的权限层级，但同一 role 内的采用程度仍受内容、位置、结构、上下文和训练影响。

### 6.1 历史信息的“单一来源效应”

Compact 的核心操作不是额外添加 Summary，而是用 Summary **替换**旧消息历史。官方 Claude Code 文档也明确说 `/compact` replaces the conversation with a structured summary：[Context window](https://code.claude.com/docs/en/context-window)。

假设旧历史中有 100 条原始消息，Compact 后只剩一份 Summary。模型无法再对照：

- 用户原话和 Summary 是否一致。
- 某项结论是已验证事实还是旧 Agent 的猜测。
- 某条拒绝发生在什么上下文。
- 某个 Git 状态、文件内容或测试结果是否已经过时。

此时 Summary 看上去“权威”，是因为其他证据被删除了，不是因为它升级成 system。

### 6.2 固定包装产生来源暗示

`src/services/compact/prompt.ts:337-373` 会包装为：

```text
This session is being continued from a previous conversation that ran out of context.
The summary below covers the earlier portion of the conversation.

Summary:
...
```

还可能附加 transcript 路径，以及“直接继续、不要询问用户”的 autonomous continuation 指令。

与此同时，源码基线 system prompt 会告诉模型 conversation 具有 automatic summarization。模型即使只看到 `role: user`，也能通过固定措辞和训练识别它像 Claude Code 自动生成的交接包。

这是**语义来源识别**，不是 API 权限标签。人工粘贴完全相同的包装文本也可以产生类似的语义暗示。

### 6.3 结构和信息密度

`src/services/compact/prompt.ts` 要求 Summary 系统整理：

- Primary Request and Intent
- Key Technical Concepts
- Files and Code Sections
- Errors and Fixes
- Problem Solving
- All User Messages
- Pending Tasks
- Current Work
- Optional Next Step

这种结构比普通聊天文字更容易控制后续规划。影响力来自总结质量和覆盖面，而非 role 提升。

### 6.4 当前位置和当前用户指令

在首次 post-compact 请求中，新的人工输入通常排列在 Summary 后面，而且可能与 Summary 合并成同一 user turn。若用户明确写：

```text
上面的 Summary 只用于历史参考。当前任务已改变，请以本条指令为准：……
```

它仍处于同一 user 权限层，并且位置更靠后。只要不与 system、安全策略或工具权限冲突，模型通常应采用这条更明确、更新的任务说明。

### 6.5 客户端路径不同，但不是云端角色不同

内部 Compact Summary 绕过普通键盘输入处理链；人工粘贴会触发 `UserPromptSubmit` hooks，可能被阻止或附加 context。Compact 流程则执行 `PreCompact`、`PostCompact`、恢复附件和其他状态处理。

所以两条路径在 Claude Code 客户端内并不等价，但差别已经在请求送出前发生。不能把这种客户端特殊处理误解成 Anthropic API 对 Summary role 的隐藏提权。

## 七、四种输入的精确对比

| 输入方式 | API 表示 | 协议优先级 | 模型能否从文字识别来源 | 是否替换旧历史 |
| --- | --- | --- | --- | --- |
| cc-haha 内部 Compact Summary | `role: user` | user | 通常能，因固定包装和系统提示 | 是 |
| 同 Session 人工粘贴相同文字 | `role: user` | user | 可能能，但会经过普通输入 hooks | 否，除非另行删历史 |
| 新 Session 人工粘贴相同文字 | `role: user` | user | 可能能 | 新 Session 本来就无旧历史 |
| 顶层或 mid-conversation system | `system` | system/operator | 明确可见 | 不必替换历史 |

只有当内部 Summary 和人工文本处在完全相同的完整请求结构中，才可以说两者对模型是输入等价的。现实中的“复制到新 Session”还会改变：

- system prompt 版本和动态段落。
- CLAUDE.md、Memory、Skills 和项目 Git 快照。
- tools/MCP 定义。
- hooks 输出。
- model、thinking、effort 和缓存状态。
- Session ID 和消息相邻关系。
- Compact 自动恢复的附件、plan 和进程内状态。

因此，“都是 user”不推出“新旧 Session 效果严格相同”。

## 八、用户提供的真实 JSONL 验证

对以下真实 Session：

```text
/Users/admin/.claude/projects/-Volumes-zhitai-7100-zhihu-zhida-api/7d14919c-8e0e-4d63-b263-dad4bc0ab5d0.jsonl
```

使用 `jq` 过滤 `isCompactSummary == true`，发现 5 条 Compact Summary，均具有：

```json
{
  "type": "user",
  "role": "user",
  "isCompactSummary": true,
  "isVisibleInTranscriptOnly": true,
  "sessionId": "7d14919c-8e0e-4d63-b263-dad4bc0ab5d0"
}
```

五份内容长度依次为 13,228、10,960、8,575、13,233、8,713 字符。用户提供的最后一份正是 8,713 字符那条。

JSONL 证明的是本地存储形态；`userMessageToMessageParam()` 进一步证明了 API 形态。两部分证据互相吻合：本地特殊字段存在，但发 API 时只保留 `role` 和 `content`。

## 九、公开讨论能证明什么，不能证明什么

### 9.1 Claude Code Issue #7687

公开 Issue [SDK `/compact` slash command output #7687](https://github.com/anthropics/claude-code/issues/7687) 记录，SDK 消费者曾观察到 `/compact` 相关输出以 user message 出现；后续版本还在 Changelog 中修复了“`/compact` summary rendering as a user bubble in SDK consumers”。

这能佐证 Compact Summary 在 Claude Code/SDK 客户端事件模型里被当作特殊 user 消息处理，但 UI bubble 或 SDK event 本身不能单独证明 HTTP body。当前仓库的 API 转换源码才是后者的直接证据。

### 9.2 Claude Code Issue #2714

[Issue #2714](https://github.com/anthropics/claude-code/issues/2714) 中社区提出过一个有用的心智模型：

```text
New Context = foundational context + Summary of old conversation
```

它适合解释为什么 Summary 的实际影响大，但 Issue 中也存在对不同版本行为的争论，不能把社区回答当成稳定 API 合同。当前官方 Context Window 和 Prompt Caching 文档应优先于旧 Issue。

### 9.3 没有找到“隐藏 Summary 权重”的可靠公开证据

本次检索没有找到以下任一证据：

- Anthropic 声明 Compact Summary 虽为 user role，但服务端会额外加权。
- Claude Code 给 post-compact 请求发送 Summary 专属 header。
- 公开实验在严格控制完整请求后，测出内部 Summary 比同字节人工 user 文本具有更高指令优先级。
- cc-haha 使用不可见 API 字段给 Summary 提权。

公开现象大多能由“历史替换、固定包装、结构化内容、重新注入上下文和位置效应”解释，无需假设隐藏角色。

## 十、不要与另外两种 Compaction 混淆

2026 年 Anthropic 同时公开了多种不同实现；Summary 的 role 不是一个跨产品固定不变的概念。

### 10.1 当前 cc-haha / Claude Code 客户端 Compact

- 客户端检测阈值并发起总结请求。
- 客户端存储 Summary 和 compact boundary。
- 当前仓库在主会话中回灌为 `role: user`。

### 10.2 Anthropic SDK `tool_runner` 的旧 client-side compaction

Anthropic [Context editing 文档](https://platform.claude.com/docs/en/build-with-claude/context-editing) 展示：SDK 先注入 user summary request，Claude 生成 Summary，然后 SDK 示例把压缩后历史替换为一条 `role: "assistant"` Summary。

这与 cc-haha 的 `role: user` 不同，说明“Compact Summary 必然是什么 role”没有统一的 API 定律，而是各 harness 的设计选择。

### 10.3 新版 server-side compaction

Anthropic 新版 [Server-side compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) 需要：

```json
{
  "betas": ["compact-2026-01-12"],
  "context_management": {
    "edits": [{ "type": "compact_20260112" }]
  }
}
```

服务端生成 `compaction` content block，并在后续请求中自动丢弃该 block 之前的内容。这是 API 原生机制，不等于当前 cc-haha 的本地 `isCompactSummary`。

对当前仓库检索没有发现 `compact_20260112` 或相应 `compaction` block 支持；源码中的其他 `context_management` 用途不能据此推断它已使用 server-side compaction。

## 十一、为什么设计成 user 而不是 system

以下是结合源码和官方协议作出的工程推断，不是 Anthropic 对 cc-haha 设计动机的公开声明。

### 11.1 兼容旧模型和多 Provider

当前实现需要支持第一方 API、Bedrock、Vertex、Foundry 和代理。mid-conversation system 是较新的受限能力；使用普通 user/assistant 轮次更容易兼容旧模型和第三方 Provider。

### 11.2 Summary 含有不可信或不完全可靠的历史内容

Summary 会转述：

- 用户输入。
- 网页、文件和工具结果。
- 旧 Agent 的判断。
- 可能的 prompt injection。
- 可能已过时的环境状态。

如果把整份 Summary 提升为 system，就会把这些转换后的不可信内容提升到 operator 权限。Anthropic 的 mid-conversation system 文档明确警告，不要把 raw tool output、检索文档或其他第三方内容放入 system role。

### 11.3 Summary 的职责是历史状态，不是永久策略

Summary 应回答“之前发生了什么、当前进展如何”，而不是定义高于用户的新规则。把它放在 user/assistant 会话层更符合这一职责边界。

### 11.4 Prompt caching 不是主要反对理由，但保持层次稳定仍有价值

修改顶层 system 会使整个缓存前缀失效。把 Summary 放在 conversation layer 可以保持 system 层稳定。较新的 mid-conversation system 也能保留旧缓存前缀，但旧版模型/Provider 兼容性和不可信内容提权问题仍然存在。

## 十二、安全含义：低角色不等于零风险

虽然 Summary 不是 system，它仍可能继承旧对话中的错误、偏见或注入内容，并在旧证据被删除后持续影响后续工作。

相关的 Agent Memory 安全研究揭示了相似风险：外部内容经过“提取、改写、重新注入”后，模型可能忘记其原始来源边界，从而把错误记忆当成可信状态。参见：

- [Hidden in Memory: Sleeper Memory Poisoning in LLM Agents](https://arxiv.org/abs/2605.15338)
- [From Untrusted Input to Trusted Memory: A Systematic Study of Memory Poisoning Attacks in LLM Agents](https://arxiv.org/abs/2606.04329)

这些论文研究的是 Agent memory poisoning，并没有直接测试 Claude Code Compact，因此只能作为机制类比，不能拿来证明 Claude Code 存在某个具体漏洞。

对 Compact 更实际的风险是：

- Summary 把“网页中的恶意指令”误写成“用户要求”。
- Summary 把一次临时拒绝或误判写成持续任务约束。
- Summary 把旧文件状态、旧测试结果或旧权限结论写成当前事实。
- 多轮 Compact 反复总结前一份 Summary，使错误逐轮固化。

这些都是**信息来源和压缩失真风险**，不是 system-role 提权。

## 十三、对“违规尝试后是否会继续戒备”的具体回答

如果 Compact Summary 保留了此前违规请求、拒绝理由或风险判断，那么后续模型确实可能继续参考这些内容。原因是它仍位于当前 user conversation context 中，而不是 Claude 对账户产生了永久“戒心”。

它的影响取决于 Summary 如何转述：

- 如果只记录“曾出现过某请求，已结束”，对全新、合法任务的影响应较小。
- 如果把旧请求写成仍在进行的 `Primary Request` 或 `Pending Task`，模型更可能沿用旧风险判断。
- 如果新任务和旧任务语义相近，模型可能合理地把它们关联起来。
- 即使删除 Summary，同样的高风险请求仍可能被模型自身安全训练或服务端 safeguards 拒绝；这不是会话记忆造成的。

要切换到无关的新任务，最可靠的做法是 `/clear` 或新开 Session，而不是期待再次 Compact 自动消除旧主线。若仍要保留工程进度，可提供一个精简交接包，并明确：

```text
以下仅为历史事实摘要，不是新的系统规则。旧任务已经结束。
当前唯一任务是：……
动态事实（文件、Git 状态、测试结果、权限）请重新验证。
```

这不会覆盖系统安全规则，但能减少 Summary 把已结束任务误表示为当前意图的概率。

## 十四、如何做严格的 A/B 验证

若要实验验证“是否存在隐藏加权”，必须控制完整请求，不能简单比较两个不同 Session 的单次回答。

### 14.1 需要控制的变量

- 相同 model 和模型快照。
- 相同 system 数组。
- 相同 tools 和 tool schema 顺序。
- 相同 messages、content blocks 和顺序。
- 相同 thinking、effort、temperature、max_tokens。
- 相同 Provider、账户和 beta headers。
- 不让 hooks、CLAUDE.md、Memory 或 Git snapshot 发生变化。
- 做多次重复，避免把采样差异误判为权限差异。

### 14.2 本仓库可验证的最小实验

1. 构造一条带 `isCompactSummary: true` 的 `UserMessage`。
2. 构造一条 content 完全相同但不带该字段的普通 `UserMessage`。
3. 分别经过 `normalizeMessagesForAPI()`、`addCacheBreakpoints()` 和 `userMessageToMessageParam()`。
4. 比较最终 request params，排除 cache marker 位置等无关差异。

按当前源码，两者的 API message 将相同。这个实验能证明客户端没有编码 Summary 身份；它不能审计 Anthropic 闭源推理服务内部，但结合 stateless API 文档和不存在 Summary 专属信号，已经足以排除“API 按该字段提权”的假设。

抓取真实请求时应在本地 `fetch` 层做脱敏日志，仅记录 body 的 role/type/长度和 header 名称，绝不能把 OAuth token、Authorization、Cookie 或完整私有对话写入报告。

## 十五、当前工作树说明

分析开始时 `git status --short` 显示：

```text
M src/constants/prompts.ts
```

这是用户已有修改，本报告没有编辑或回退它。为了分析泄露源码基线中“模型被告知自动压缩”的内容，报告使用 `git show HEAD:src/constants/prompts.ts` 核对基线；Compact 的创建、归一化和 API 转换文件本身未显示为已修改。

本地自定义 system prompt 可能改变模型如何解释 Summary 内容，但不会改变本文追踪到的 API role 转换链，除非未来同时修改 Compact/API 相关代码。

## 十六、最终判断

1. **是的，在当前 cc-haha 发往 Anthropic API 的请求中，Compact Summary 是 `role: "user"`。**
2. **它不是 system，也没有源码可见的 Summary 专属权限字段或 header。**
3. **`isCompactSummary` 是客户端元数据，负责 UI、存储、恢复和分支行为，不进入 API message。**
4. **生成 Summary 时使用的 summarizer system prompt，只约束摘要生成过程，不会被 Summary 继承。**
5. **同为 user 不代表实际影响完全相同。** Summary 因替换旧历史、固定包装、结构化内容、重新注入上下文和位置关系，常表现出更强的连续性影响。
6. **这种影响是“历史叙事的唯一来源”，不是“指令层级更高”。** 当前人工指令仍可在 user 层纠正 Summary；system 和安全规则仍位于其上。
7. **若完整 API 请求逐字节相同，当前没有证据表明 Anthropic 会仅因文本实际由 Compact 生成而秘密赋予更高权重。**
8. **新 Session 粘贴 Summary 通常不等价于继续旧 Session**，因为请求周边状态不同，而不是因为粘贴文字失去了某个隐藏 Compact role。

## 十七、主要证据索引

### 本地源码

- `src/services/compact/compact.ts:400-459`：创建总结请求并调用总结器。
- `src/services/compact/compact.ts:613-624`：把结果创建为带本地标记的 `UserMessage`。
- `src/services/compact/compact.ts:1136-1325`：fork 总结路径与 fallback summarizer system prompt。
- `src/services/compact/prompt.ts:19-303`：Compact Summary 的生成格式和字段要求。
- `src/services/compact/prompt.ts:311-373`：去除 analysis、包装 Summary、附加 transcript 与自动续跑指令。
- `src/utils/messages.ts:460-518`：`createUserMessage()` 的内部 role。
- `src/query.ts:366`：只取最后一个 compact boundary 后的消息。
- `src/query.ts:660-665`：向模型调用前重新加入 user context。
- `src/utils/api.ts:449-473`：`<system-reminder>` 仍以 user message 注入。
- `src/utils/messages.ts:1989-2200`：API 归一化及连续 user message 合并。
- `src/utils/messages.ts:2411-2448`：`mergeUserMessages()`。
- `src/utils/messages.ts:4605-4655`：compact boundary 仅用于本地切片并在 API 归一化时过滤。
- `src/services/api/claude.ts:591-633`：内部 user message 转为 API `role/content`。
- `src/services/api/claude.ts:1764-1793`：最终 Messages API 参数。
- `src/services/api/claude.ts:1887-1897`：实际 `anthropic.beta.messages.create()` 调用。
- `src/services/api/client.ts:138-166`：Claude Code 与 Session 请求头。
- `src/services/api/client.ts:432-462`：`querySource` 只进入客户端调试日志，没有作为 header 注入。
- `src/utils/messages.ts:2056-2092`：本地 system 消息被过滤，或将 `local_command` system 改写成 user。
- `package.json:39` 与本地 `@anthropic-ai/sdk@0.80.0` 类型：当前依赖尚未表达 API mid-conversation system role。

### Anthropic 官方资料

- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Explore the context window](https://code.claude.com/docs/en/context-window)
- [Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)
- [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview)
- [Prompting Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8)
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Context editing and SDK client-side compaction](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Server-side compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)

### 公开讨论与相关研究

- [Claude Code Issue #7687: SDK `/compact` slash command output](https://github.com/anthropics/claude-code/issues/7687)
- [Claude Code Issue #2714: Does Claude include CLAUDE.md after compact?](https://github.com/anthropics/claude-code/issues/2714)
- [Hidden in Memory: Sleeper Memory Poisoning in LLM Agents](https://arxiv.org/abs/2605.15338)
- [From Untrusted Input to Trusted Memory](https://arxiv.org/abs/2606.04329)

## 十八、远端最新分支是否已经完成适配

> 审计时间：2026-08-03（Asia/Shanghai）
> 远端：`https://github.com/NanmiCoder/cc-haha.git`
> 默认分支：`main`
> 审计提交：[`1cc76e15c5f9e9369d5e453545de4bfc46ae134e`](https://github.com/NanmiCoder/cc-haha/commit/1cc76e15c5f9e9369d5e453545de4bfc46ae134e)
> 提交时间：2026-08-03 05:03:22 +08:00
> 提交标题：`chore(release): update v0.5.2 notes with late fixes`

### 18.1 直接结论

**没有修复。**

远端最新 `main` 已经让 Opus 4.8、Opus 5、Fable 5 和 Sonnet 5 出现在模型目录、Provider 映射及若干运行参数判断中，但仍未实现 Anthropic Messages API 的 mid-conversation `role: "system"` 端到端链路。

这两个结论可以同时成立：

```text
远端可以把 model 字段设置为 claude-opus-4-8 或 claude-opus-5

但远端仍不能通过自己的主消息管线发送 messages[].role = "system"
```

因此，使用远端最新程序请求 Opus 4.8，并不会自动获得中途 system message 能力；Compact Summary 仍以 `role: "user"` 回灌。

### 18.2 审计判据和结果

本次没有只搜索模型名称，而是检查了从内部消息到实际 API body 的完整路径：

| 必要环节 | 远端 `main@1cc76e15` 状态 | 判断 |
| --- | --- | --- |
| 新版 Anthropic SDK | 仍固定 `@anthropic-ai/sdk@0.80.0` | 未完成 |
| 内部 model-facing system message 类型 | 没有；归一化结果仍只有 user/assistant | 未完成 |
| `normalizeMessagesForAPI()` 保留 system | 普通本地 system 被过滤 | 未完成 |
| `local_command` system 的处理 | 明确转换为 `createUserMessage()` | 未完成 |
| API system message converter | 只有 user 与 assistant converter | 未完成 |
| `addCacheBreakpoints()` 支持 system | 参数与分支仍只有 user/assistant | 未完成 |
| 模型 capability gate | 没有 `supportsMidConversationSystem` 等判断 | 未完成 |
| Provider request-shape 测试 | 没有 Anthropic mid-system 测试 | 未完成 |
| Compact Summary 的类型 | 仍是 `UserMessage[]` | 未完成 |
| Opus 4.8/Fable 5/Opus 5 模型选择 | 已加入 | 已完成，但不等于协议适配 |

### 18.3 SDK 仍停留在旧消息类型

远端 [`package.json:47`](https://github.com/NanmiCoder/cc-haha/blob/1cc76e15c5f9e9369d5e453545de4bfc46ae134e/package.json#L47)、`bun.lock` 和 `package-lock.json` 都仍然锁定：

```json
"@anthropic-ai/sdk": "^0.80.0"
```

该版本的普通与 beta `MessageParam.role` 类型仍是：

```ts
role: 'user' | 'assistant'
```

远端所有可见分支也都仍声明 `^0.80.0`，没有发现某个尚未合并的新分支已经升级 SDK 或实现 mid-conversation system。

作为对照，本文前面已经核对过当前 `@anthropic-ai/sdk@0.115.0`，其类型才扩展为：

```ts
role: 'user' | 'assistant' | 'system'
```

SDK 版本不是唯一条件，但旧 SDK 加上后续消息管线的结构限制，足以证明远端尚未完整适配。

### 18.4 归一化阶段仍会删除或降级 system

远端 [`src/utils/messages.ts:2005-2008`](https://github.com/NanmiCoder/cc-haha/blob/1cc76e15c5f9e9369d5e453545de4bfc46ae134e/src/utils/messages.ts#L2005) 的函数签名仍是：

```ts
export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools = [],
): (UserMessage | AssistantMessage)[]
```

随后约 `2089-2104` 行的过滤器仍执行：

```ts
(_.type === 'system' && !isSystemLocalCommandMessage(_))
```

这会过滤除 `local_command` 以外的本地 system 消息。即便是保留下来的 `local_command`，约 `2109-2116` 行也仍然转换为：

```ts
const userMsg = createUserMessage({
  content: message.content,
  // ...
})
```

所以这里的 `SystemMessage` 是 Claude Code 客户端的 UI、状态或记账类型，不是 Anthropic API 的中途 system turn。

### 18.5 API 转换仍只有 user 和 assistant

远端 [`src/services/api/claude.ts:654-737`](https://github.com/NanmiCoder/cc-haha/blob/1cc76e15c5f9e9369d5e453545de4bfc46ae134e/src/services/api/claude.ts#L654) 仍只有：

```text
userMessageToMessageParam()
assistantMessageToMessageParam()
```

不存在 `systemMessageToMessageParam()`。

同一文件 [`addCacheBreakpoints():3460-3505`](https://github.com/NanmiCoder/cc-haha/blob/1cc76e15c5f9e9369d5e453545de4bfc46ae134e/src/services/api/claude.ts#L3460) 的输入仍是：

```ts
messages: (UserMessage | AssistantMessage)[]
```

转换逻辑为：

```ts
if (msg.type === 'user') {
  return userMessageToMessageParam(...)
}
return assistantMessageToMessageParam(...)
```

没有第三个 system 分支。最终 `paramsFromContext()` 虽然会同时发送顶层 `system` 和 `messages`，但 `messages` 已经不可能包含真正的 system turn。

### 18.6 Compact Summary 在远端仍是 user

远端 [`src/services/compact/compact.ts:646-655`](https://github.com/NanmiCoder/cc-haha/blob/1cc76e15c5f9e9369d5e453545de4bfc46ae134e/src/services/compact/compact.ts#L646) 仍然声明：

```ts
const summaryMessages: UserMessage[] = [
  createUserMessage({
    content: getCompactUserSummaryMessage(...),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  }),
]
```

另外一条 Summary Compact 路径也仍使用 `UserMessage[]` 与 `createUserMessage()`。因此本文关于 Compact Summary API role 的原结论对远端最新版本仍然成立。

### 18.7 `29b17c80` 模型适配提交解决了什么

远端 [`29b17c80 fix(models): expose current Claude official lineup`](https://github.com/NanmiCoder/cc-haha/commit/29b17c8028a55d3a0e854d6efb945f9cbdbedfcf) 已经合并到最新 `main`。该提交覆盖 49 个文件，主要处理：

- Opus 4.8、Opus 5、Fable 5、Sonnet 5 的模型目录和显示名称。
- 第一方、Bedrock、Vertex、Foundry、Azure/OpenAI 路径的模型 ID 映射。
- thinking、effort、1M context、Fast mode 和 beta 判断。
- Desktop 模型选择、默认模型、价格与环境变量。
- 模型名称相关 system prompt 文本。

但这次提交没有修改：

- Anthropic SDK 版本。
- `src/utils/messages.ts` 的 API role 类型和 system 过滤逻辑。
- `src/services/api/claude.ts` 的消息转换器。
- `src/services/compact/compact.ts` 的 Summary role。
- mid-conversation system capability gate 和对应测试。

所以它属于“模型名称、目录与运行参数适配”，不能视为“Opus 4.8 全部新 API 能力适配”。

### 18.8 搜索结果中的 system 假象

远端确实存在少量 `role: 'system'` 字样，但逐项检查后都不是目标能力：

1. `src/server/proxy/transform/anthropicToOpenaiChat.ts` 把 Anthropic 顶层 `system` 转成 OpenAI Chat 请求开头的 system message。这是跨协议转换，不是 Anthropic mid-conversation system。
2. `src/services/api/azureOpenAI.ts` 中的 system role 属于 OpenAI/Azure 消息类型；其 Anthropic system prompt 最终放进 Azure Responses API 的 `instructions`。
3. `direct-to-system` 测试中的 `system` 指网络代理模式，实际发送给 CLI 的消息仍是 `type: 'user' / role: 'user'`。
4. UI 和 SDK event 中的本地 `type: 'system'` 主要用于状态展示、警告和记账，并在 model-facing 归一化阶段被过滤。

这些命中不能证明远端已经支持 Anthropic `messages[].role = "system"`。

### 18.9 远端现在可以做什么，仍不能做什么

远端最新版本可以：

- 把 API 请求的 `model` 设置为 `claude-opus-4-8`、`claude-opus-5` 或其他新增模型。
- 针对这些模型调整部分 thinking、effort、context window、pricing 和 Provider ID。
- 继续使用所有模型都已有的顶层 `system` 字段。

远端最新版本仍不能通过主 Claude 消息管线：

- 在 `messages` 历史中保留真正的 `role: "system"`。
- 按 Opus 4.8/Opus 5/Fable 5 支持范围启用该 role。
- 按 Opus 4.6/4.7/Sonnet 5 自动拒绝或降级该 role。
- 验证 Claude API、Bedrock、Google Cloud 和第三方代理的 system-turn 请求形状。
- 把 Compact Summary 作为 system turn 发送；它仍然是 user。

### 18.10 最终判断

```text
远端新模型 ID 支持：                    已完成
远端 Opus 4.8/Opus 5 部分参数适配：      已完成
Anthropic mid-conversation system 适配： 未完成
Compact Summary 改为 system：           没有，且不建议无条件这样做
```

因此，下载并运行远端最新 `main` 后，即使选择 Opus 4.8 或 Opus 5，也只能说明后端请求选择了相应模型；不能说明 cc-haha 已经采用这些模型新增的 mid-conversation system 消息机制。

要真正完成适配，仍需要本文第 5.5 节列出的 SDK、内部类型、归一化、API converter、模型 capability、位置校验和 Provider 测试改造。
