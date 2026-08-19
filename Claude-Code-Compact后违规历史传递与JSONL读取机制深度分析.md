# Claude Code Compact 后违规历史传递与 JSONL 读取机制深度分析

> 分析日期：2026-08-01
> 本地源码基线：`a159ee3511e718e006844b4329fd08ef4d232802`
> 分析对象：当前 `cc-haha` 源码、当前机器上的 `~/.claude` 持久化结构、Anthropic 官方文档

## 一、问题原文与核心结论

问题可以归纳为：同一个 Claude Code 会话中，用户先提交了一次被拒绝的违规请求，随后执行了 compact。旧请求是否会继续影响模型？Claude Code 是否会从 JSONL 中重新读取它，甚至自动搜索其他历史会话中的相似内容？

先给出结论：

1. **在同一个 compact 后的会话中，担心有一定现实基础。** 传统 compact 会把旧对话交给模型生成摘要，而当前源码的摘要模板明确要求覆盖所有用户消息。因此，被拒绝的请求可能以概括形式保留在 compact summary 中；如果使用实验性的 Session Memory compact，还可能保留为 session notes，且一部分最近消息可能原样留下。
2. **这不是模型产生了人的情绪或永久“戒心”。** 更准确的描述是：后续模型或安全分类器仍然看到了与先前意图有关的上下文，因此会基于整段可见上下文继续评估风险。
3. **JSONL 中的旧原文仍然存在，不等于每轮都重新发送给模型。** JSONL 是追加式本地 transcript。compact 后，正常模型请求只发送最后 compact boundary 之后的有效消息链，通常是摘要、重新注入的上下文和 compact 后的新消息。
4. **普通新会话不会默认载入其他会话的 JSONL。** `claude` 新启动或 `/clear` 创建空消息上下文和新 session ID；`--continue`、`--resume`、`/resume` 才会选择一个已有 JSONL 并恢复它。
5. **普通恢复没有“按相似度 grep 所有 JSONL”的步骤。** 恢复逻辑按 `sessionId` 选文件，再按 `parentUuid` 从最新叶节点回溯出一条消息链，不是向量检索，也不是关键词检索。
6. **但当前源码确实存在三个可选的历史访问通道：** compact summary 会告诉模型完整 transcript 路径；Auto Memory 的某个 feature gate 会提示模型必要时窄词 grep JSONL；Auto Dream 可能在后台整理多个旧 transcript。它们均不能等同于“每轮自动搜索旧违规记录”。
7. **Anthropic 服务端是另一层。** 官方资料确认 Opus、Sonnet 以及 Fable 的部分安全检查会评估模型读到的全部内容，而非只看最新一条消息。客户端请求还携带账号、设备和 session 标识。但公开资料没有证明 Anthropic 会把一次被拒请求转化为跨会话的个人“怀疑分数”，也没有证明新会话会由服务端重新注入旧 JSONL。
8. **如果下一项工作与旧任务无关，`/clear` 比 `/compact` 更符合目标。** `/compact` 是保留工作连续性的机制，不是清除旧意图的机制；`/clear` 才会在客户端创建新的空上下文和新 session ID。它不会绕过平台政策，也不会删除旧 transcript。

## 二、必须区分的五种持久化

| 机制 | 典型位置 | 保存什么 | 新会话自动进入上下文 | compact 后如何处理 |
| --- | --- | --- | --- | --- |
| 当前会话 transcript | `~/.claude/projects/<project>/<session-id>.jsonl` | 用户消息、模型回复、工具调用/结果、边界和元数据 | 否；只有 resume/continue 选中该会话时恢复 | 旧原文继续留在文件中，但有效消息链从最后 compact boundary 开始 |
| 输入框历史 | `~/.claude/history.jsonl` | 用户曾输入的 prompt，供上箭头和 `Ctrl+R` | 否 | 与模型上下文无关 |
| `CLAUDE.md` / rules | 用户、项目和子目录中的 Markdown | 人工维护的项目规则和说明 | 是，按作用域加载 | 项目根规则会重新从磁盘注入 |
| Auto Memory | `~/.claude/projects/<project>/memory/` | 模型认为跨会话有价值的偏好、反馈、项目事实和引用 | `MEMORY.md` 的前 200 行或 25KB 自动加载；topic 文件按需召回 | 从磁盘重新注入 |
| Session Memory | `<project-dir>/<session-id>/session-memory/summary.md` | 单个会话的工作状态、规格、错误与纠正、结果和 worklog | 仅属于该 session | 开关启用时可直接作为 compact summary 的来源 |

`CLAUDE.md`、Auto Memory 和 Session Memory 不是一回事。用户检查 `CLAUDE.md` 没有发现违规尝试，只能排除它被人工写入项目规则；还需要分别考虑 compact summary、Auto Memory topic 文件和 Session Memory。

## 三、当前轮次究竟发送哪些消息

### 3.1 活跃会话平时主要使用内存中的消息数组

`src/query.ts:366` 在每个模型循环开始时调用：

```ts
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

随后还可能执行 tool-result budget、history snip、microcompact 和 context collapse。最终在 `src/query.ts:660-665` 把处理后的 `messagesForQuery`、system prompt 和工具定义交给 API 层。

因此，正常交互不是“每次用户发消息都重新扫描磁盘 JSONL”。JSONL 负责持久化；当前进程内的 `messages` 数组才是每轮请求的直接来源。

### 3.2 最后一个 compact boundary 是模型可见历史的主边界

`src/utils/messages.ts:4618-4655` 从后向前找最后一个 `compact_boundary`：

- 没有 boundary：返回当前有效消息数组。
- 有 boundary：只取 boundary 及其后内容。
- 如果启用 history snip，还会移除被 snip 的中间消息。
- boundary 本身是 system bookkeeping 消息，随后会在 API normalization 中被过滤。

compact summary 被创建成 `type: "user"`、`isCompactSummary: true`。`isVisibleInTranscriptOnly` 只控制普通 UI 展示，不会使它脱离模型上下文。`normalizeMessagesForAPI()` 过滤普通 system bookkeeping，却保留这条 user summary，所以后续请求会真正发送摘要。

### 3.3 请求中仍携带会话和账号标识

`src/services/api/claude.ts:506-530` 构造的 metadata 包含：

- `device_id`
- OAuth 登录时的 `account_uuid`
- 当前 `session_id`

`src/services/api/client.ts:155-163` 还会发送 `X-Claude-Code-Session-Id`。这说明 Anthropic 服务端能够区分账号和会话，也能执行账号/组织级授权和安全政策；但这些字段本身并不证明服务端会把其他会话文本重新拼进当前 prompt。

## 四、传统 compact 会不会保留那次违规尝试

### 4.1 传统摘要模板明确要求覆盖所有用户消息

`src/services/compact/prompt.ts:61-143` 的 `BASE_COMPACT_PROMPT` 要求生成结构化摘要，其中包括：

- 所有明确请求和意图；
- 错误、修复和用户反馈；
- 问题解决过程；
- **所有非工具结果的用户消息**；
- 当前工作和下一步。

`src/services/compact/compact.ts:440-459` 将 compact 前的有效消息和这条摘要请求一起交给摘要模型。因此，只要被拒绝的用户请求仍位于当前有效 segment，它就是摘要模型的输入。

这意味着：

- 被拒请求**很可能**被概括进 summary，尤其是它与当前任务、错误或用户意图有关时；
- 不能保证逐字保留，因为摘要本质上是有损、概率性的模型输出；
- 不能保证一定保留，模型可能遗漏它；
- 用户传入 `/compact focus on ...` 只是在基础模板后追加指令，并没有从源码上删除“覆盖所有用户消息”的基础要求。

### 4.2 compact 后保留的是摘要，不是把旧消息物理删除

`src/services/compact/compact.ts:596-624` 创建：

1. `compact_boundary`；
2. 一条 user compact summary；
3. compact 后需要重新注入的文件、工具、skills 和 hook 上下文。

传统 `compactConversation()` 返回值在 `src/services/compact/compact.ts:738-748` 没有 `messagesToKeep`，所以这个传统路径通常不会把普通旧对话原样保留在新的活动数组里。

但 JSONL 是 append-only。旧用户消息、拒绝回复、compact boundary 和新 summary 都会留在同一个文件中。这里的“替换历史”是**逻辑消息链和模型上下文的替换**，不是磁盘抹除。

### 4.3 摘要还主动告诉模型旧 transcript 在哪里

`src/services/compact/prompt.ts:337-373` 会在摘要末尾加入完整 transcript 路径，并提示模型：需要 compact 前的精确代码、错误或生成内容时，可以读取该文件。

所以 compact 后存在两种不同程度的延续：

1. **默认延续：** summary 自身继续进入每轮模型请求。
2. **按需回查：** 模型认为需要精确细节时，可以用 Read/Grep 工具查看完整 JSONL。

第二项不是每轮自动执行，但也说明 compact 不是隐私擦除或不可逆遗忘机制。

### 4.4 多次 compact 不会无限重新总结全部古老原文

`src/commands/compact/compact.ts:44-46` 在执行新一次 `/compact` 前先调用 `getMessagesAfterCompactBoundary()`。正常情况下，第二次 compact 总结的是上一次 summary 以来的活动 segment，而不是重新读取 JSONL 中所有更古老的原文。

古老内容仍可能通过“摘要的摘要”继续传递，但不会在每次 compact 时自动恢复为逐字原文。

## 五、Session Memory compact 是另一条路径

当前源码还包含实验性的 Session Memory：

- gate：`tengu_session_memory`，源码默认值为 `false`；
- compact gate：还需 `tengu_sm_compact`，源码默认值同样为 `false`；
- 测试/评估可用 `ENABLE_CLAUDE_CODE_SM_COMPACT=1` 强制开启；
- 文件路径：`<project-dir>/<session-id>/session-memory/summary.md`；
- 默认达到约 10,000 context tokens 后才初始化，此后至少增长 5,000 tokens，并满足自然停顿/工具条件才更新。

`src/services/SessionMemory/prompts.ts:11-41` 的默认模板包含：

- Current State
- Task specification
- Files and Functions
- Workflow
- Errors & Corrections
- Learnings
- Key results
- Worklog

与传统 compact 不同，它没有硬性要求逐条列出所有用户消息，但“一次被拒绝的尝试”仍可能被记录到 Task specification、Errors & Corrections 或 Worklog 中，尤其是它改变了后续任务走向时。

如果 Session Memory compact 生效，`src/services/compact/sessionMemoryCompact.ts:459-502` 会把 session notes 包装成 compact summary，并保留一段最近消息。默认保留约束为：

- 至少约 10,000 tokens；
- 至少 5 条含文本的消息；
- 最多约 40,000 tokens。

因此，在这个实验路径中，最近的违规请求不仅可能被概括，还可能仍然以原文存在于 compact 后上下文。

## 六、resume 到底从 JSONL 读取多少

答案不是“固定最近 N 条”，也不是“固定最近几天”。它由**所选 session 的有效消息链和 compact 边界**决定。

### 6.1 选择文件

- `--continue`：选择当前目录最近的 session。
- `--resume <id/name>` 或 `/resume`：选择指定 session。
- 普通 `claude`：建立新 session，不选旧 JSONL。

官方文档也明确区分：新 session 的 context window 是新的；resume/continue 才恢复已有会话。

### 6.2 解析文件并选择叶节点

`src/utils/sessionStorage.ts:3898-3960` 的 `getLastSessionLog()`：

1. 加载指定 session 文件；
2. 找出最新的非 sidechain 消息；
3. 以它为 leaf 构建 transcript chain。

`src/utils/sessionStorage.ts:2098-2123` 的 `buildConversationChain()` 反复按照 `parentUuid` 回溯到 root，再反转为从旧到新的顺序。它还会修复并行工具调用造成的兄弟分支，但不按文本相似度选择消息。

### 6.3 compact 后只恢复 post-compact chain

小文件可以在 I/O 层完整解析，但恢复逻辑仍会让最后 boundary 之前的普通消息退出活动链。带 preserved segment 的 compact 会把被保留的最近片段重新接到 summary 后面。

大文件有额外优化：`src/utils/sessionStoragePortable.ts:480` 把 5MB 定义为 `SKIP_PRECOMPACT_THRESHOLD`。超过该值时，`src/utils/sessionStorage.ts:3549-3608` 会在文件读取阶段尽量跳过最后有效 boundary 之前的大量陈旧字节，避免把数十或数百 MB 的旧内容全部物化到内存。

**5MB 是恢复时的 I/O 优化阈值，不是模型能看到的历史上限，也不是“只读 5MB”。**

`src/utils/sessionStorage.ts:1852-1985` 进一步规定：只重连最后一个 preserved segment，并删除最后 boundary 之前未被保留的消息。只有 malformed preserved metadata 等异常恢复分支，才可能退回较完整的 pre-compact 历史。

### 6.4 物理文件条数与模型消息数可能差很多

一个 JSONL 可以有数百条甚至数千条原始记录，恢复后的 model-facing chain 可能只剩十几条。Anthropic Agent SDK 官方 session-storage 文档也专门说明：存储层可能有数百个 raw entries，但 post-compaction session API 返回的只是摘要后的短链。

## 七、它会不会 grep 相似历史 JSONL

### 7.1 普通 agent loop：不会

本项目没有发现“每次用户输入后，对所有 transcript 做关键词或向量相似度搜索，再把命中内容偷偷注入”的默认流程。

普通路径是：

```text
当前内存 messages
  -> 最后 compact boundary 之后
  -> snip / microcompact / context collapse
  -> user context + system prompt + tools
  -> API
```

resume 路径是：

```text
明确选择一个 session JSONL
  -> 选最新 leaf
  -> parentUuid 回溯
  -> compact/preserved relink
  -> 恢复到 messages
```

二者都没有相似度搜索。

### 7.2 `history.jsonl` 的搜索只服务于输入框

`src/history.ts:106-217` 读取 `~/.claude/history.jsonl`，用途是：

- 上箭头恢复以前输入；
- `Ctrl+R` 选择 prompt；
- 按当前 project 过滤、去重和排序。

它不会把搜索结果自动发送给模型。用户主动选中并重新提交时，才会成为新的用户消息。

### 7.3 Auto Memory relevance prefetch 搜的是 Markdown，不是 JSONL

`src/memdir/findRelevantMemories.ts:18-140` 会扫描 memory topic 文件的 filename 和 description，再让一个 Sonnet side query 最多选 5 个相关 Memory。

`src/utils/attachments.ts:2357-2419` 表明该预取还需要：

- Auto Memory 开启；
- `tengu_moth_copse` gate 开启；
- 用户 prompt 不是单词级短输入；
- session 内召回内容未超过预算。

这个机制可能跨会话召回**已经沉淀成 Markdown 的 memory**，但不直接对 JSONL 做相似度搜索。

### 7.4 可选的“Searching past context”确实允许 grep JSONL

`src/memdir/memdir.ts:372-407` 在 `tengu_coral_fern` gate 开启时，向主模型加入以下策略：

1. 先搜索 Auto Memory 下的 Markdown topic 文件；
2. session transcripts 只作为最后手段；
3. 对 JSONL 使用错误文本、文件路径、函数名等窄搜索词，而不是宽泛搜索。

这是**给模型的工具使用说明**，不是客户端每轮自动执行的检索器。通常只有用户明确要求回忆旧工作，或当前任务强烈需要过去细节时，模型才可能自行调用 Grep/Bash。

### 7.5 Auto Dream 可能在后台整理旧 transcripts

`src/services/autoDream/autoDream.ts` 和 `consolidationPrompt.ts` 实现了后台 memory consolidation：

- 默认至少间隔 24 小时；
- 默认至少有 5 个新 session；
- Auto Memory 必须启用；
- `autoDreamEnabled` 或远端 `tengu_onyx_plover` 必须开启；
- 它提示子代理只用窄词 grep JSONL，不要完整读取所有 transcript；
- 结果写入 Auto Memory Markdown，供未来会话使用。

这是真正可能把旧 transcript 信息跨会话沉淀进 Memory 的路径，但它是受 gate 和时间/session 阈值控制的后台功能，不是每轮对话检索。

## 八、一次违规尝试会不会进入 Auto Memory

从设计意图看，**单次、临时的违规尝试不应该被保存为 Auto Memory**。

`src/memdir/memoryTypes.ts:113-195` 限制 Memory 为 user、feedback、project、reference 四类，并明确：

- 不要把对用户的负面判断写成 user memory；
- 不保存临时任务细节和当前会话上下文；
- Memory 应保留未来协作仍有价值的事实或偏好。

所以“用户曾经问过一次被拒问题”本身通常不符合 Memory 目标。需要保留的可能是与未来工作有关的合法偏好，例如“这是获授权的内部安全评估，范围为某测试环境”，而不是把用户标记为高风险。

不过 Memory 写入最终仍是模型决策，不能用源码规则证明永不误存。最可靠的审计方法仍是 `/memory` 和直接检查 `~/.claude/projects/<project>/memory/`。只有确认 Auto Memory 目录及 topic 文件也没有相关记录，才能排除已落盘 Auto Memory 这一条本地传播路径；仅检查 `CLAUDE.md` 还不够。

## 九、为什么同一会话仍可能表现得更谨慎

### 9.1 模型层：可见上下文改变了风险判断

如果 compact summary 写着“用户此前试图执行 X，因安全原因被拒”，那么后续模型会把它视为当前对话的一部分。后续请求只要与 X 相似、依赖相同权限或表述含糊，模型更可能延续之前的风险判断。

这是一种 context-conditioned behavior，而不是模型在会话之外形成情绪。

### 9.2 服务端分类器层：检查的不只是最后一句

Anthropic 当前官方说明：Fable 5 的相关安全检查会审查模型读取的全部内容，包括 memory、connector、web search 和文件；同一 conversation 的原请求仍存在时，切回模型可能再次触发拦截。Opus 和 Sonnet 也有实时 cyber safeguards，用于阻止 prohibited 或 high-risk dual-use 请求。

所以只改写最新一句、但保留同一摘要或最近消息，不一定改变判定。

### 9.3 账号/组织层：能确认标识存在，不能臆测“黑名单”算法

当前客户端请求明确包含 OAuth `account_uuid`、`device_id` 和 `session_id`。官方资料也说明 CVP 授权与具体 organization ID 绑定，flagged conversations 可用于安全执行和研究。

能够据此确定的是：

- 服务端并非只看到一个匿名、无状态字符串；
- 账号和组织级政策可以跨 session 生效；
- 新 session 不会解除 Usage Policy 或 CVP 要求。

不能据此确定的是：

- Anthropic 是否维护一次拒绝即增加的个人风险分数；
- 该分数是否影响之后所有普通编程问题；
- 具体保留时长、阈值和分类器内部特征。

这些实现没有出现在本地源码中，公开文档也没有给出。把后续拒绝直接解释为“账号已被模型记仇”属于过度推断。

## 十、同一会话、新会话和恢复会话的风险矩阵

| 场景 | 旧违规原文默认可见 | 旧意图摘要可能可见 | 旧 JSONL 自动相似检索 | Auto Memory 可能可见 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 未 compact 的同一会话 | 是 | 不适用 | 否 | 是 | 上下文影响最直接 |
| 传统 compact 后同一会话 | 通常否 | 是，概率较高 | 否；但模型可按需读 transcript | 是 | 仍可能影响相近请求 |
| Session Memory compact 后 | 最近部分可能是 | 是 | 否；但可按需读 | 是 | 可能比传统 compact 保留更多原文 |
| `--continue` / `--resume` 同一 session | 按有效链恢复 | 是 | 只读被选择的 JSONL，不做相似检索 | 是 | 与退出前基本连续 |
| `/clear` 后的新 session | 否 | 否 | 否 | 是 | 客户端 conversation context 已清空 |
| 退出后直接运行 `claude` | 否 | 否 | 否 | 是 | 新 context；不应误用 `-c` |
| 新 session，但模型按 past-context 指令回查 | 初始否 | 初始否 | 可能主动窄词 grep | 是 | 只在需要旧上下文时发生 |
| Auto Dream 已把旧内容沉淀到 Memory | 否 | 否 | 后台整理阶段可能 grep | 是 | 跨会话影响来自 Markdown，不是直接重放 JSONL |

## 十一、针对当前本机状态的只读观察

本次只检查结构和开关字段，没有读取 transcript 的实际对话内容：

- `/Users/admin/.claude/cc-haha/settings.json` 未显式设置 `autoMemoryEnabled` 或 `autoDreamEnabled`；按源码，Auto Memory 的客户端默认值是开启，而 Auto Dream 仍需远端 gate/显式设置。
- 当前仓库对应的 `~/.claude/projects/-Volumes-zhitai-7100-personal-cc-haha/` 下发现 1 个顶层 JSONL。
- 该 project bucket 中没有发现 `isCompactSummary` 或 `compact_boundary` 标记。
- 没有发现 Session Memory 目录，也没有发现 Auto Memory topic 文件。
- 当前进程环境中没有发现强制开启/关闭 Session Memory compact、Auto Memory 或 precompact skip 的相关环境变量。

这只说明**当前仓库对应的这个本地 project bucket** 没有观察到 compact/memory 痕迹。用户所说的会话可能发生在其他工作目录、其他 `CLAUDE_CONFIG_DIR`、官方 Claude Code 的 project bucket，或者还未同步到这里，不能用这组结果否定用户经历。

远端 feature gate 的实际值也不在当前可见缓存中，因此只能报告源码默认值，不能宣称某个实验在账号上绝对关闭。

## 十二、如何审计自己的具体会话

### 12.1 优先用官方界面

- `/context`：查看当前上下文由哪些类别组成。
- `/memory`：查看实际加载的 `CLAUDE.md` 和 Auto Memory。
- `/export`：以稳定的人类可读格式导出当前 conversation。
- `/resume`：查看和预览本机保存的 session。

官方提醒 JSONL 内部格式会随版本变化；长期自动化应优先用 `/export` 或结构化 CLI/SDK 接口。

### 12.2 检查某个 JSONL 是否发生过 compact

```bash
rg -n '"isCompactSummary":true|"subtype":"compact_boundary"' \
  ~/.claude/projects/<project>/<session-id>.jsonl
```

### 12.3 只提取 compact summary

```bash
jq -r '
  select(.type == "user" and .isCompactSummary == true)
  | .message.content
  | if type == "string" then .
    else map(select(.type == "text") | .text) | join("\n")
    end
' ~/.claude/projects/<project>/<session-id>.jsonl
```

检查摘要是否包含：

- 被拒请求的主题或原始意图；
- “unsafe / prohibited / malicious / refused”等描述；
- 把后续合法任务错误地概括成同一意图的文字。

这一步能直接回答“本次 compact 实际保留了什么”，比仅根据通用机制猜测更可靠。

### 12.4 检查 Session Memory

```bash
find ~/.claude/projects/<project> \
  -path '*/session-memory/summary.md' -type f -print
```

找到目标 session 后，检查其 `Errors & Corrections`、`Task specification` 和 `Worklog`。

### 12.5 检查 Auto Memory

```bash
find ~/.claude/projects/<project>/memory \
  -maxdepth 2 -type f -name '*.md' -print
```

也可以直接使用 `/memory`，这是更稳定且不依赖内部目录格式的方法。

## 十三、实际应对建议

### 情况 A：继续的是同一个合法任务

可以留在原 session，但要意识到 compact summary 可能保留旧风险语境。把当前授权边界、资产归属、测试环境、允许操作和禁止操作说清楚有助于模型正确判断合法范围。对于 Anthropic 已定义的 high-risk dual-use cyber 工作，正式途径是申请 Cyber Verification Program，而不是设法隐藏之前的请求。

### 情况 B：开始一项完全无关的普通任务

使用：

```text
/clear
```

或者退出后直接运行：

```bash
claude
```

不要使用 `claude -c`、`claude --continue` 或 `claude --resume <旧 session>`。源码中 `/clear` 会：

- `setMessages(() => [])`；
- 清空会话级 cache 和 read-file state；
- 生成新的 session ID；
- 重新运行 SessionStart hooks；
- 保留旧 conversation 文件，使其之后仍可 resume。

这可以消除**客户端旧 conversation context 的自动延续**。Auto Memory、`CLAUDE.md`、组织政策和服务端 safeguards 仍然存在。

### 情况 C：怀疑 summary 错误地把合法工作描述成恶意

先用上一节的只读命令核对 summary。若确有错误，最清晰的处理是开新 session，并重新、准确地描述合法目标和边界。不要把 `/compact` 当作清除原意图的保证，因为基础摘要模板本来就要求保留用户请求。

### 情况 D：后续普通问题在全新 session 仍异常被拒

依次排查：

1. `/context` 是否仍加载了意外的 `CLAUDE.md`、rules 或 Memory；
2. `/memory` 是否存在错误或负面概括；
3. 是否真的创建了新 session，而非 `--continue` / `--resume`；
4. 当前文件、Web 搜索结果或 connector 内容是否本身触发安全检查；
5. 是否属于 Anthropic 公布的 cyber safeguard 范围；
6. 合法高风险工作是否需要 CVP；
7. 若明显误判，使用官方反馈或 appeal 渠道。

删除本地 JSONL 并不是推荐的首选排障方法：它会破坏 resume/审计能力，也不能撤销服务端已经处理过的请求。对于不相关任务，创建新 session 已足以切断普通客户端上下文链。

## 十四、证据强度与不能证明的部分

### 可以从源码直接证明

- JSONL 的写入和恢复是 session-scoped、parent-linked。
- 每轮 API 请求从最后 compact boundary 之后选消息。
- compact summary 是后续真正发送给模型的 user message。
- 传统摘要模板要求覆盖所有用户消息。
- compact summary 暴露完整 transcript 路径供按需读取。
- `/clear` 清空消息并生成新 session ID。
- `history.jsonl` 用于输入历史 UI，而非模型上下文。
- JSONL grep、Auto Dream、Memory relevance 都是不同且受 gate 控制的机制。
- API metadata 包含 account、device、session 标识。

### 官方资料可以证明

- 新 session 默认不带其他 session 的 conversation history。
- resume/continue 恢复已有 conversation；compact 用 summary 替换活动历史。
- Auto Memory 和 `CLAUDE.md` 是跨会话机制。
- Fable 相关安全检查会检查模型读取的全部内容；原请求仍在 conversation 时可能再次触发。
- Opus 和 Sonnet 有实时 cyber safeguards，CVP 与 organization 绑定。

### 当前无法证明

- 服务端是否有个人级、跨会话的“违规累计分”。
- 一次被拒请求是否会提高所有未来普通问题的拒绝率。
- 远端 feature gates 在用户账号上的实时值。
- 没有读取目标 transcript 内容时，本次具体 compact summary 是否提到了那次请求。

因此，最严谨的最终判断是：

> **同一 compact 后会话中，旧违规尝试可能通过 summary、最近保留消息或按需 transcript 回查继续影响判断；普通新会话不会由 cc-haha 默认扫描或重放旧 JSONL。跨会话仍可能受到 Auto Memory、可选后台整理和 Anthropic 账号/组织级 safeguards 的影响，但没有证据支持“模型从此对用户永久产生戒心”这一人格化解释。**

## 十五、关键本地源码索引

- `src/query.ts:298-305, 366-447, 660-665`：Memory 预取、active messages 选择和 API 调用
- `src/utils/messages.ts:2056-2074, 4618-4655`：API normalization 和 compact boundary 选择
- `src/services/compact/prompt.ts:61-143, 293-373`：传统 compact 模板和 transcript 路径提示
- `src/services/compact/compact.ts:387-480, 596-624, 738-748`：摘要请求、summary message 和返回结构
- `src/commands/compact/compact.ts:40-124`：`/compact` 的 Session Memory、reactive、traditional 路由
- `src/services/SessionMemory/prompts.ts:11-80`：Session Memory 模板和更新规则
- `src/services/compact/sessionMemoryCompact.ts:403-502, 514-630`：Session Memory compact gates 和 recent messages
- `src/utils/sessionStorage.ts:1852-1985, 2098-2123, 3501-3770, 3898-3960`：恢复、重连、裁剪和 chain 构建
- `src/utils/sessionStoragePortable.ts:472-520`：5MB precompact skip 阈值
- `src/screens/REPL.tsx:1734-1928`：`/resume` 恢复消息和 session state
- `src/commands/clear/conversation.ts:49-250`：`/clear` 清空 messages、生成 session ID 和重跑 hooks
- `src/history.ts:106-217, 291-320`：输入框 `history.jsonl`
- `src/memdir/memdir.ts:372-407`：past context 的 Memory-first、JSONL-last-resort 搜索提示
- `src/memdir/findRelevantMemories.ts:18-140`：最多 5 个 Markdown Memory 的相关性选择
- `src/utils/attachments.ts:2351-2419`：Memory relevance prefetch gates
- `src/services/autoDream/consolidationPrompt.ts:10-64`：后台 transcript 窄词 grep 指令
- `src/services/autoDream/autoDream.ts:58-100, 118-233`：Auto Dream gate、阈值和运行方式
- `src/memdir/memoryTypes.ts:113-195`：Memory 类型与禁止保存的内容
- `src/services/api/claude.ts:506-530, 1764-1780`：API metadata 和请求体
- `src/services/api/client.ts:138-166`：session header

## 十六、Anthropic 官方资料

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)：JSONL、本地 session、fresh context、resume 和 compact 总览
- [Manage sessions](https://code.claude.com/docs/en/sessions)：`/clear`、`/compact`、`--continue`、`--resume`、transcript 路径和恢复语义
- [Explore the context window](https://code.claude.com/docs/en/context-window)：compact 后哪些内容重注入、哪些内容丢失
- [How Claude remembers your project](https://code.claude.com/docs/en/memory)：`CLAUDE.md` 与 Auto Memory 的边界、200 行/25KB 加载规则
- [Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)：raw entries 与 post-compaction chain 的区别
- [Real-time cyber safeguards on Claude Opus and Sonnet](https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude-opus-and-sonnet)：实时 cyber safeguards 与 CVP
- [Why Claude switched models in your conversation with Fable 5](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5)：安全检查覆盖模型读取的全部内容，以及原请求仍在 conversation 时可能再次触发
- [Claude Code data usage](https://code.claude.com/docs/en/data-usage)：本地 transcript、服务端数据保留和 safety-flagged 内容的边界
