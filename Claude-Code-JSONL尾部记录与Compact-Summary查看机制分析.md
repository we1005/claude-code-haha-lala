# Claude Code JSONL 尾部记录与 Compact Summary 查看机制分析

## 一、审计对象与结论

本文分析以下 Claude Code 会话文件：

```text
/Users/admin/.claude/projects/-Volumes-zhitai-7100-zhihu-zhida-api/7d14919c-8e0e-4d63-b263-dad4bc0ab5d0.jsonl
```

检查时该文件共 `8569` 行。第 `8555` 行到文件末尾共有 15 条记录。

核心结论：

1. 第 8555 行是一次完整的 Compact Summary，持久化形式为特殊标记的 `user` 消息。
2. 第 8556-8569 行主要是 `/compact`、`/resume`、`/memory` 和 `/exit` 的本地命令、终端输出、合成消息及文件历史快照。
3. JSONL 不是一个 JSON 数组，而是“一行一个独立 JSON 值”的流式记录格式。
4. 该 JSONL 不只是 Anthropic API 消息列表，而是 Claude Code 的会话事件日志。`type: "system"` 不必然代表 Anthropic API 的 `role: "system"`。
5. 后续继续对话若干轮，不会使第 8555 行的 Compact Summary 从 JSONL 中消失。
6. `Ctrl+O` 不是“显示最新 Summary”的专用快捷键，而是打开整个 Transcript 视图。对话变长以后，Summary 仍可查看，但可能需要滚动、Transcript 搜索或展开全部历史。
7. 当前源码没有 `/summary`、`/show-compact` 之类专门回显最近一次 Compact Summary 的斜杠命令。直接查询 JSONL 是最确定的方法。

## 二、第 8555 行到结尾分别是什么

| 行号 | 主要内容 | 记录性质 |
| --- | --- | --- |
| 8555 | Compact 生成的完整 Summary | `type: "user"`、`message.role: "user"`、`isCompactSummary: true` |
| 8556 | 本地命令免责声明 | `isMeta: true` 的 user 元数据 |
| 8557 | 用户执行 `/compact` | 本地命令输入记录 |
| 8558 | `/compact` 的终端输出 | Compact 成功提示，以及 PUA PreCompact hook 执行失败信息 |
| 8559 | 执行 `/resume` | `type: "system"`、`subtype: "local_command"` 的本地事件 |
| 8560 | `Resume cancelled` | 本地命令输出 |
| 8561 | 执行 `/memory` | 本地命令事件 |
| 8562 | 打开 `./CLAUDE.md` | 本地命令输出 |
| 8563 | `No response requested.` | `model: "<synthetic>"`、Token 为 0 的合成 assistant 消息 |
| 8564 | 再次执行 `/memory` | 本地命令事件 |
| 8565 | 取消 Memory 编辑 | 本地命令输出 |
| 8566 | 文件历史快照 | `type: "file-history-snapshot"`，本次没有文件备份 |
| 8567 | `/exit` 前的本地命令免责声明 | `isMeta: true` 的 user 元数据 |
| 8568 | 执行 `/exit` | 本地命令输入记录 |
| 8569 | `See ya!` | `/exit` 的本地终端输出 |

从内容上看，第 8555 行之后没有新的正常任务对话。第 8563 行也不是真实 Claude 模型生成的回复：其模型名是 `<synthetic>`，输入和输出 Token 均为 0。

## 三、第 8555 行为什么是 Compact Summary

其关键结构可简化为：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "This session is being continued from a previous conversation..."
  },
  "isVisibleInTranscriptOnly": true,
  "isCompactSummary": true,
  "uuid": "fae4fc60-07c2-4845-b557-e5afbc7dff4d"
}
```

两个字段最关键：

- `isCompactSummary: true`：明确标记这不是普通用户输入，而是 Compact 生成的摘要。
- `message.role: "user"`：摘要在持久化消息结构中采用 user role，而不是顶层 system role。

`isVisibleInTranscriptOnly: true` 是 UI/记录可见性标记。它使该消息在普通精简对话界面中隐藏，而在 Transcript 模式中显示完整内容。它不会把消息提升成 API system role。

当前项目的 Compact 实现也直接证明了这一点。在 `src/services/compact/compact.ts` 中，摘要通过 `createUserMessage()` 创建，并附加：

```ts
isCompactSummary: true,
isVisibleInTranscriptOnly: true,
```

## 四、JSONL 是否就是多个 JSON 顺序拼接

可以这样理解，但更准确的名称是 JSON Lines 或 newline-delimited JSON：每一行都是一个完整、可独立解析的 JSON 值，行与行之间由换行符分隔。

普通 JSON 数组：

```json
[
  {"type": "user"},
  {"type": "assistant"}
]
```

JSONL：

```jsonl
{"type":"user"}
{"type":"assistant"}
```

JSONL 的特点：

- 没有外层 `[]`。
- 相邻对象之间没有逗号。
- 本文件中每个物理行都是一个完整 JSON object。
- 可以逐行、流式解析，不需要一次把整个会话加载进内存。
- 整个文件不能直接当成单个普通 JSON object 解析。
- 使用 `jq -s` 可以把所有行收集成一个 JSON 数组。

逐行验证：

```bash
jq -c . session.jsonl
```

转换成普通 JSON 数组：

```bash
jq -s . session.jsonl
```

## 五、为什么 JSONL 不能等同于 Anthropic API messages

该文件更准确地说是 Claude Code 的会话事件日志，其中混合保存：

- 用户消息；
- Assistant API 响应；
- Compact Summary；
- 工具调用和工具结果；
- 本地斜杠命令及其 stdout/stderr；
- UI 状态和合成消息；
- 文件历史快照；
- 错误、父子 UUID 和分支信息。

例如第 8559 行是：

```json
{
  "type": "system",
  "subtype": "local_command",
  "content": "<command-name>/resume</command-name>..."
}
```

它没有 `message.role`，表示 Claude Code 内部的 system 类本地事件，而不是 Anthropic API 的 mid-conversation `role: "system"` 消息。

恢复会话或发起下一次请求时，Claude Code 会沿有效会话链加载记录，再经过消息归一化、Compact boundary 截取和本地事件过滤。它不会把 JSONL 的每一行从头到尾原样发送给 Anthropic API。

## 六、这个文件实际有几次 Compact

按 `isCompactSummary: true` 检索，该文件共有 5 条 Compact Summary：

| JSONL 行号 | 时间戳 | Summary UUID | 内容字符数 |
| --- | --- | --- | ---: |
| 1577 | `2026-07-21T12:37:15.934Z` | `f51a2f77-1dfc-4d6e-814f-39b65395b93d` | 13228 |
| 3227 | `2026-07-22T09:13:46.567Z` | `593765a8-3866-4995-b3ff-01c53bd0d0ce` | 10960 |
| 5229 | `2026-07-23T09:11:54.741Z` | `99d9227b-859a-4015-baf6-21026d027c43` | 8575 |
| 7055 | `2026-07-24T02:52:48.977Z` | `ee5b435f-3565-424f-8347-6b2ea7e5b317` | 13233 |
| 8555 | `2026-08-01T13:08:41.878Z` | `fae4fc60-07c2-4845-b557-e5afbc7dff4d` | 8601 |

因此，第 8555 行是这个文件中最新的一次 Compact Summary，但不是唯一一次。

## 七、后续对话几轮后，Ctrl+O 还能不能看到 Summary

### 7.1 直接答案

**能看到，Summary 不会因为后续对话几轮就自动消失。**

但 `Ctrl+O` 的真实语义是切换 `prompt` 与 `transcript` 两种屏幕，而不是“跳转到最近一次 Summary”。相关默认绑定位于 `src/keybindings/defaultBindings.ts`：

```ts
'ctrl+o': 'app:toggleTranscript'
```

`src/hooks/useGlobalKeybindings.tsx` 中的处理函数也只是把屏幕在以下两个状态间切换：

```text
prompt <-> transcript
```

所以刚完成 Compact 时，Summary 距离当前视口很近，按 `Ctrl+O` 看起来像是“直接打开 Summary”。继续对话很多轮之后，再按 `Ctrl+O` 通常会进入 Transcript 的最新位置；Summary 仍在历史中，只是不一定恰好出现在当前屏幕。

### 7.2 为什么 Transcript 模式能显示完整 Summary

`src/components/CompactSummary.tsx` 明确区分两种显示方式：

- 普通 prompt 模式：只显示 `Compact summary` 或 `Summarized conversation` 以及 `Ctrl+O` 提示。
- transcript 模式：渲染 `textContent`，也就是 Summary 的完整正文。

`src/utils/messages.ts` 也规定：带有 `isVisibleInTranscriptOnly` 的 user 消息只在 Transcript 模式中显示。

因此，完整 Summary 的显示入口确实是 Transcript，而不是普通聊天主界面。

### 7.3 当前全屏/虚拟滚动模式

当前源码的全屏虚拟滚动 Transcript 会保留全部可滚动消息，不再只保留最后几十条。进入方式和查找方式如下：

1. 按 `Ctrl+O` 进入 Transcript。
2. 使用方向键、`Home`/`End`、`j`/`k`、`Ctrl+U`/`Ctrl+D` 滚动。
3. 按 `/` 打开 Transcript 搜索。
4. 搜索 Summary 中的明显文本，例如：

```text
This session is being continued
```

5. 按 Enter 保留搜索结果，再用 `n`/`N` 在下一个/上一个匹配之间移动。

源码 `src/utils/transcriptSearch.ts` 会把 user 消息的字符串正文纳入搜索索引，因此 Compact Summary 的正文可以被搜索到。

### 7.4 非全屏或关闭虚拟滚动的兼容模式

在非虚拟滚动路径中，Transcript 默认只渲染最后 30 条可显示消息：

```ts
const MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30
```

如果 Compact 后又产生了超过约 30 条可显示记录，`Ctrl+O` 单独打开的视图可能看不到 Summary。此时应在 Transcript 中按：

```text
Ctrl+E
```

它对应 `transcript:toggleShowAll`，会展开此前隐藏的消息。随后使用终端滚动查找 Summary。

### 7.5 当前源码提供的其他 Transcript 查看手段

在启用全屏虚拟滚动时：

- `[`：把完整 Transcript 展开并输出到终端 scrollback，随后可以使用终端或 tmux 的查找功能。
- `v`：将渲染后的 Transcript 写入临时文本并用 `$VISUAL`/`$EDITOR` 打开。

不过，如果目标是确保看到 Compact Summary，优先使用 Transcript 内搜索或直接查询 JSONL。原因是当前 `v` 和 `/export` 共用 `renderMessagesToPlainText()`，静态渲染时采用 `screen="prompt"`；对于标记为 `isVisibleInTranscriptOnly` 的整段 Compact Summary，这条路径不保证输出完整正文。

## 八、有没有专门查看本次 Compact Summary 的命令

当前源码中没有以下专用斜杠命令：

```text
/summary
/show-summary
/show-compact
/compact-history
```

几个容易混淆的命令分别是：

- `/compact`：重新执行一次上下文压缩，不是查看旧 Summary。
- `/context`：显示上下文/Token 使用情况，不回显 Compact Summary。
- `/resume`：选择或恢复会话，不是 Summary 查看器。
- `/export`：导出渲染后的会话，但如上所述，不适合作为提取 `isVisibleInTranscriptOnly` Summary 的权威途径。

所以实际优先级是：

1. `Ctrl+O` 进入 Transcript，再用 `/` 搜索。
2. 兼容模式下使用 `Ctrl+E` 展开全部历史。
3. 需要原始、完整、可复制文本时，直接使用 `jq` 从 JSONL 提取。

## 九、直接从 JSONL 查看 Compact Summary

先设置文件变量：

```bash
FILE='/Users/admin/.claude/projects/-Volumes-zhitai-7100-zhihu-zhida-api/7d14919c-8e0e-4d63-b263-dad4bc0ab5d0.jsonl'
```

查看第 8555 行的 Summary 正文：

```bash
sed -n '8555p' "$FILE" | jq -r '.message.content'
```

列出所有 Compact Summary 的行号、时间和正文：

```bash
jq -r '
  select(.isCompactSummary == true) |
  "line=\(input_line_number) timestamp=\(.timestamp)\n\(.message.content)\n---"
' "$FILE"
```

只提取最新一次 Compact Summary：

```bash
jq -sr '
  [.[] | select(.isCompactSummary == true)] |
  last |
  .message.content
' "$FILE"
```

只列出所有 Summary 的索引信息，不输出正文：

```bash
jq -r '
  select(.isCompactSummary == true) |
  [input_line_number, .timestamp, .uuid, (.message.content | length)] |
  @tsv
' "$FILE"
```

直接查询 JSONL 的优势是不会受 UI 视口、最后 30 条限制、终端 scrollback、折叠渲染或 `/export` 可见性规则影响。

## 十、最终判断

对这次具体会话而言：

- 第 8555 行就是最新一次 Compact 的完整 Summary。
- 继续对话几轮后，它仍保存在 JSONL，也仍属于 Transcript 历史。
- `Ctrl+O` 仍然有效，但只是进入 Transcript，不保证自动定位到第 8555 行对应的 Summary。
- 在当前全屏模式中，进入 Transcript 后按 `/` 搜索 `This session is being continued` 是最方便的 UI 操作。
- 在旧式或非虚拟滚动模式中，先按 `Ctrl+E` 展开全部历史。
- 没有专门回显“最近一次 Compact Summary”的斜杠命令。
- 若需要百分之百准确地读取原始 Summary，使用 `jq` 从 JSONL 按 `isCompactSummary: true` 提取最可靠。
