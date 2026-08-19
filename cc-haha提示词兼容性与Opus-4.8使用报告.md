# cc-haha 提示词兼容性与 Opus 4.8 使用报告

> 分析日期：2026-07-20
>
> 分析范围：当前 `cc-haha` 泄露版源码、`/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md`、`/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/`

## 1. 结论

此前“把 Claude.ai 的 Fable 5 提示词放进 Claude Code，会让模型收到大量不存在或不匹配的工具”这句话方向正确，但需要结合当前源码说得更精确：

1. `--system-prompt-file` 会替换当前 `cc-haha` 默认 system prompt。
2. `cc-haha` 仍会通过 Anthropic Messages API 的独立 `tools` 字段发送真实工具定义。
3. Markdown 中写入的 Claude.ai 工具不会因此注册成真实工具。
4. 模型会同时看到两套互相矛盾的信息：
   - System prompt 文本声称存在 Claude.ai 工具、路径和产品能力。
   - API `tools` 字段只提供 `cc-haha` 当前真正启用的工具。
5. 所以主要风险不是“Claude.ai 工具真的被加载”，而是**文本工具说明与真实工具 Schema 冲突，导致错误工具选择、错误路径、能力幻觉和额外上下文消耗**。

对 Opus 4.8，最佳选择仍是不用替换参数：

```bash
claude --model claude-opus-4-8
```

如果明确需要完全自定义 coding-agent 行为，可以使用本报告同时生成的：

```bash
claude \
  --model claude-opus-4-8 \
  --system-prompt-file "/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Opus-4.8替换系统提示词.md"
```

对当前仓库入口则是：

```bash
./bin/claude-haha \
  --model claude-opus-4-8 \
  --system-prompt-file "/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Opus-4.8替换系统提示词.md"
```

该 Markdown 只定义通用 coding-agent 行为，不复制工具 Schema，不假装自己是某个模型，也不负责解锁 Opus 4.8。实际模型仍取决于请求 model ID、账号权限和服务端响应。

## 2. 当前源码中的真实行为

### 2.1 CLI 确实读取并传递完整文件

`src/main.tsx` 注册并处理：

```text
--system-prompt <prompt>
--system-prompt-file <file>
--append-system-prompt <prompt>
--append-system-prompt-file <file>
```

`--system-prompt-file` 的文件内容被读取到 `systemPrompt`，随后作为 `customSystemPrompt` 进入 REPL 或 QueryEngine。

相关位置：

- `src/main.tsx:989`
- `src/main.tsx:1346`
- `src/main.tsx:1354`

### 2.2 Custom prompt 替换默认提示词

`src/utils/systemPrompt.ts:115` 的优先级逻辑是：

```text
agent prompt
  > customSystemPrompt
  > defaultSystemPrompt
```

核心选择相当于：

```ts
customSystemPrompt ? [customSystemPrompt] : defaultSystemPrompt
```

然后才追加 `appendSystemPrompt`。

因此使用 `--system-prompt-file` 后，以下默认提示模块不再作为主 system prompt 使用：

- coding-agent intro。
- 默认 System/Harness 说明。
- Doing tasks。
- Actions/reversibility。
- Using your tools。
- Tone and style。
- Memory mechanics。
- Environment/model information。
- MCP instructions。
- Scratchpad instructions。
- Function-result clearing 等动态片段。

当前工作树的 `src/constants/prompts.ts` 还存在用户未提交修改：移除了原有 cyber-risk prompt 引用并增加了一个自定义安全过滤片段。使用 `--system-prompt-file` 时，这个本地默认提示修改同样会被绕过，因为整个默认提示路径被 custom prompt 替换。

本报告没有修改或恢复该文件。

#### 2.2.1 当前目录中的 Opus 4.7 默认提示词在哪里

当前仓库确实包含 Opus 4.7 使用的 Claude Code 默认提示词源码。它不是一个独立的 `.md` 文件，而是主要由以下代码组成：

- `src/constants/prompts.ts`：默认 system prompt 的静态段和动态段。
- `src/constants/system.ts`：在 API 请求阶段额外加入 Claude Code/Agent SDK 身份前缀。
- `src/constants/systemPromptSections.ts`：动态段缓存和更新机制。
- `src/tools/*/prompt.ts`：每个工具独立的文字说明。
- 各工具的 `inputSchema`：工具参数的 JSON Schema。

使用当前工作树配置、空工具数组和模型 ID `claude-opus-4-7` 直接调用 `getSystemPrompt()`，实际得到：

| 项目 | Opus 4.7 默认构造结果 | 本报告生成的替换文件 |
| --- | ---: | ---: |
| `SystemPrompt` 字符串块 | 11 | 1 |
| 合并后字符数 | 24,744 | 10,882 |
| 空白分词数 | 约 3,883 | 1,607 |
| 工具 Schema | 不在上述数字中，API 另发 | 不在文件中，API 仍另发 |

默认构造结果包含这些主要章节：

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

其中 `auto memory`、`Environment`、MCP instructions、skills、output style 和 session guidance 都可能根据账号、设置、工作目录、工具池、feature flags 和会话状态变化。因此，“仓库包含 Opus 4.7 提示词源码”是正确的；但“存在一个静态 Opus 4.7 Markdown，可以原样改名为 Opus 4.8 后完全等价”并不正确。

此外，`src/constants/prompts.ts` 并没有为 Opus 4.7 维护一整套独立正文。大多数 coding-agent 规则是模型共享的，模型参数主要影响：

- `Environment` 中的模型名称、精确 model ID 和 knowledge cutoff。
- Function-result clearing 等模型能力相关动态段。
- API thinking、betas、context management 和工具能力判断。

所以把正文中的 `4.7` 替换成 `4.8`，既不是选择模型，也不能补齐运行时对新模型的能力适配。

### 2.3 真实工具不会随默认 prompt 一起消失

`src/tools.ts:194` 的 `getAllBaseTools()` 和 `src/tools.ts:272` 的 `getTools()` 负责构造真实工具池。根据 feature、权限、运行模式和 MCP 状态，可能包含：

- `Bash`
- `Read`
- `Edit`
- `Write`
- `Agent`
- `AskUserQuestion`
- `WebFetch`
- `WebSearch`
- `Skill`
- `EnterPlanMode`
- Task 系列工具
- MCP 工具
- 其他 feature-gated 工具

`src/services/api/claude.ts:1764` 构造实际请求时，`system` 和 `tools` 是两个独立字段：

```ts
{
  model,
  messages,
  system,
  tools: allTools,
  max_tokens,
  thinking
}
```

每个真实工具还会通过 `src/utils/api.ts:119` 转换为：

```text
name + description + input_schema
```

所以：

```text
--system-prompt-file 替换系统说明
              !=
移除 API tools 字段
```

这是对之前判断最重要的修正。

### 2.4 Markdown 中的工具定义不会注册工具

`/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md` 在正文中描述了 18 个 Claude.ai 工具：

```text
ask_user_input_v0
bash_tool
create_file
fetch_sports_data
image_search
message_compose_v1
places_map_display_v0
places_search
present_files
recipe_display_v0
recommend_claude_apps
search_mcp_registry
str_replace
suggest_connectors
view
weather_fetch
web_fetch
web_search
```

这些只是自然语言和 JSON 文本。Anthropic API 不会扫描 system prompt 并把它们注册为函数。真正可调用的名字来自请求的 `tools` 字段。

与 `cc-haha` 的常见工具只有语义近似，没有稳定的名称或 Schema 等价关系：

| Claude.ai prompt 中的文本名称 | `cc-haha` 常见真实工具 | 问题 |
| --- | --- | --- |
| `bash_tool` | `Bash` | 名称、参数和沙箱说明不同 |
| `create_file` | `Write` | 路径规则和返回方式不同 |
| `str_replace` | `Edit` | 编辑协议不同 |
| `view` | `Read` | 输入 Schema 和输出格式不同 |
| `ask_user_input_v0` | `AskUserQuestion` | UI 与输入结构不同 |
| `web_fetch` | `WebFetch` | 名称大小写和调用约束不同 |
| `web_search` | `WebSearch` | 名称大小写和后端能力不同 |
| 地图/天气/菜谱/体育工具 | 通常不存在 | 除非另行接入对应 MCP，否则不可用 |

模型通常会优先从 API 实际提供的工具中选择，但超长 system prompt 仍可能让它：

- 在文本中声称要使用不存在的工具。
- 选择语义相近但参数错误的真实工具。
- 输出 Claude.ai 风格的伪工具调用文本。
- 因为同一能力出现两套互相冲突的说明而降低稳定性。

### 2.5 Interactive 与 `-p` 路径还有差异

当前源码不是所有入口都完全一致。

#### Interactive REPL

`src/screens/REPL.tsx:2769` 即使存在 custom prompt，仍会读取：

- `getUserContext()`：CLAUDE.md 和当前日期。
- `getSystemContext()`：Git status 等系统上下文。

随后 `src/screens/REPL.tsx:2794` 将 custom system prompt、user context、system context 和真实 tools 一起交给 query loop。

所以 interactive 模式中，custom prompt 替换默认 prompt，但 CLAUDE.md、日期和 Git status 仍可能通过独立上下文进入请求。

#### Headless/SDK/`-p`

`src/utils/queryContext.ts:34` 明确说明，当 custom prompt 存在时：

- 跳过默认 `getSystemPrompt()`。
- 跳过 `getSystemContext()`。
- 仍读取 `getUserContext()`。

因此 headless 路径通常仍有 CLAUDE.md 和日期，但可能没有默认 environment、memory mechanics、MCP instructions 和 Git status system context。

这意味着同一个 `--system-prompt-file` 在 interactive 与 `-p` 下可能表现不同。自定义 prompt 不应依赖某个入口一定注入 Git status、工作目录说明或 MCP 使用规则。

## 3. `/test/CLAUDE-FABLE-5.md` 到底是什么

### 3.1 文件规模

| 项目 | 数值 |
| --- | ---: |
| 行数 | 1,529 |
| 空白分隔词数 | 15,514 |
| 大小 | 109,327 bytes |
| SHA-256 | `3481aa1972c10a830d8c117da4c2483d4e891057acc1c157c096a227625e550d` |

### 3.2 Surface 证据

文件明确描述了：

- Claude Web、Mobile、Desktop chat interface。
- Web Search、Deep Research、Artifacts、past chats、memory 设置。
- `/mnt/user-data/uploads`、`/mnt/user-data/outputs`、`/home/claude`。
- Artifact 的 `window.storage`。
- 地图、天气、菜谱、体育、消息编写和连接器推荐工具。
- Claude.ai 的引用和版权规则。
- Artifact 内部调用 Anthropic API 的能力。

这些都是 Claude.ai/Claude App 产品 surface，不是本机 Claude Code repository agent surface。

### 3.3 与本地泄露目录的重合度

对非空唯一行做精确文本比较：

| 候选文件 | 本地文件行覆盖率 | Jaccard | 判断 |
| --- | ---: | ---: | --- |
| `Anthropic/claude-fable-5.md` | 39.6% | 14.5% | 与完整 Claude.ai Fable 抓取关系最强，但只是部分/不同版本 |
| `Anthropic/claude-opus-4.8.md` | 31.0% | 11.5% | 大量 Claude.ai 产品公共规则共享 |
| `Official/2026-06-09-claude-fable-5.md` | 4.0% | 3.8% | 不是单纯官方 core prompt |
| `Claude Code/claude-code-fable-5.md` | 4.5% | 1.9% | 与 Claude Code 捕获差异很大 |
| `Claude Code/claude-code-opus-4.8.md` | 4.5% | 2.0% | 与 Claude Code Opus 捕获差异很大 |

精确行比较会低估经过格式化和改写的相似内容，但方向很清楚：`/test` 文件属于 Claude.ai 产品提示家族，而不是 Claude Code 提示家族。

## 4. Anthropic 提示词目录分类对比

目录中存在多种完全不同用途的提示，不能只根据模型名选择。

### 4.1 `Official/`

代表 Anthropic 官方公开的 Claude.ai/Mobile core system prompt 历史版本。

最新相关文件：

| 文件 | 行数 | 大小 |
| --- | ---: | ---: |
| `Official/2026-05-28-claude-opus-4.8.md` | 208 | 22,800 bytes |
| `Official/2026-06-09-claude-fable-5.md` | 179 | 22,118 bytes |

适合：

- 研究 Claude.ai 核心行为差异。
- 对比模型发布时公开的消费端规则。

不适合：

- 直接充当 Claude Code coding-agent prompt。
- 提供 Bash/Read/Edit/权限/Git 等 coding harness 指导。

### 4.2 根目录 `claude-*.md`

这些是 Claude.ai 产品 surface 的大型完整或近完整抓取，通常包含工具、Artifacts、搜索、引用、Memory 和产品说明。

| 文件 | 行数 | 大小 |
| --- | ---: | ---: |
| `claude-fable-5.md` | 3,688 | 227,019 bytes |
| `claude-opus-4.8.md` | 3,769 | 183,530 bytes |
| `claude-sonnet-5.md` | 3,844 | 188,475 bytes |

适合研究 Claude.ai 部署差异，不适合直接注入 Claude Code。

### 4.3 `Claude Code/claude-code-*.md`

这是与当前问题最相关的一组。目录 README 声称它们是 Claude Code 对各模型发送内容的完整捕获，并包含：

- System prompt。
- Tool definitions。
- Agent/skill listings。
- Session context。

| 文件 | Prompt 类型 | 行数 | 大小 |
| --- | --- | ---: | ---: |
| `claude-code-opus-4.8.md` | Lean | 2,451 | 132,695 bytes |
| `claude-code-fable-5.md` | Lean | 2,546 | 140,769 bytes |
| `claude-code-sonnet-5.md` | Full | 2,888 | 171,512 bytes |
| `claude-code-opus-4.7.md` | Full | 2,854 | 170,565 bytes |

这些文件证明 Claude Code 并不是所有模型使用完全相同提示：

- Opus 4.8 与 Fable 5 使用 lean prompt。
- Sonnet 5、Opus 4.7 及更早模型使用 full prompt。
- Fable 在 Opus 4.8 基础上增加 model identity、自动运行/最终消息规则、`EndConversation` 和 `WaitForMcpServers` 等捕获差异。
- Opus 4.8 到 Fable 5 的文本差异为约 `+99/-4` 行，主体高度共享。
- Opus 4.8 到 Sonnet 5 的差异约 `+509/-72` 行，主要来自 lean/full 分支以及 tool/agent guidance 差异。

但这些 Claude Code 文件仍然**不能直接作为你自己的 `--system-prompt-file`**，原因是捕获中混入了：

- 捕获者路径 `/Users/asgeirtj/...`。
- 捕获者邮箱。
- 捕获时的 `<project-dir>`、Git status 和 CLAUDE.md。
- 捕获时启用的 feature-gated 工具。
- 当时的 model identity 和 context 描述。
- 完整工具 descriptions 和 JSON Schema。

直接再次注入会把工具描述放进 system 文本，同时 `cc-haha` 又在 API `tools` 字段发送一份当前真实 Schema，形成重复和漂移。

### 4.4 产品专用提示

`claude-cowork.md`、`claude-design.md`、`claude-in-chrome.md`、Office 提示和 Mobile 提示都绑定各自 surface。

它们适合研究对应产品的工具编排，不应该用来替代 Claude Code prompt。例如：

- Cowork 假定知识工作和桌面文件产出。
- Design 假定可视化设计工具与大量 UI 能力。
- Chrome 假定浏览器自动化 MCP。
- Excel/Word/PowerPoint 假定 Office 宿主和专用 API。

### 4.5 `old/` 与 `raw/`

这些是历史版本或未经整理的抓取。它们可能对逆向版本演进有用，但最容易包含过期工具 Schema、旧模型能力、旧路径和旧安全协议，不适合作为当前 Opus 4.8 配置。

## 5. Opus 4.8 应该使用哪个文件

### 5.1 官方 Claude Code：首选不指定文件

如果使用本机官方 `claude`，默认方式最可靠：

```bash
claude --model claude-opus-4-8
```

原因：

- CLI 会根据自身版本和模型 registry 选择 lean/full prompt。
- 工具说明和当前真实 Schema 同步。
- Environment、Memory、MCP、skills 和 permissions 动态生成。
- 新版本修复会自动进入默认 prompt。
- 不会把第三方抓取者的路径和会话状态带入请求。

### 5.2 需要自定义但保留默认能力：优先 append

如果只是增加团队规范、输出风格或工作方式，应使用：

```bash
claude \
  --model claude-opus-4-8 \
  --append-system-prompt-file "/path/to/short-rules.md"
```

这比完整替换更稳定。

### 5.3 必须使用 `--system-prompt-file`

该参数没有 Anthropic 专用的文件容器格式。当前源码只是：

```ts
systemPrompt = readFileSync(resolve(options.systemPromptFile), 'utf8')
```

因此它接受任意 UTF-8 纯文本：

- `.md`、`.txt` 或无扩展名都可以。
- 不需要 YAML frontmatter。
- 不需要 JSON 外壳。
- Markdown 标题、列表、XML 标签都只是写给模型看的普通文本结构。
- 不应放 Anthropic Messages API 的 `system`/`tools` JSON 请求体。
- 不应在文件里复制工具 `input_schema`；真实 Schema 由 CLI 的 `tools` 字段另行发送。

文件全文会成为一个 custom system prompt 字符串块，取代 `getSystemPrompt()` 生成的默认 11 个左右的块。API 请求阶段仍可能在它前面加入 Claude Code/Agent SDK attribution 和身份前缀，但默认 memory、environment、MCP 等动态正文不会自动重新并入这个文件。

这里的“格式正确”和“内容正确”必须分开：

- 根目录 `Anthropic/claude-opus-4.7.md`、`claude-opus-4.8.md` 和 `claude-fable-5.md` 都是合法 UTF-8 文本，参数可以读取。
- 但这些文件属于 Claude.ai 产品提示，不是 Claude Code coding-agent 默认正文。
- 真正同产品面的候选位于 `Anthropic/Claude Code/claude-code-*.md`。
- `claude-code-opus-4.7.md` 的 `# Session context` 之前部分最接近当前源码 full prompt。
- `claude-code-opus-4.8.md` 的对应部分最接近目标 Opus 4.8 lean prompt。
- 两个 Claude Code 完整捕获都还包含 Session Context、Agents、Skills、Tools Schema 和捕获者动态路径，不能整文件直接使用。

不要选择以下任一文件：

- `/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md`
- `Anthropic/claude-opus-4.8.md`
- `Anthropic/Official/2026-05-28-claude-opus-4.8.md`
- `Anthropic/Claude Code/claude-code-opus-4.8.md`

前三者是 Claude.ai/core prompt，最后一个是带动态状态和工具抓包的捕获文件。

本报告生成的 `Claude-Code-Opus-4.8替换系统提示词.md` 是合法的 `--system-prompt-file` 文件，并已根据 `Claude Code/claude-code-opus-4.8.md` 在 `# Session context` 之前的 lean system 部分重新组织和清洗。它更适合作为替换文件，因为它：

- 不硬编码模型身份或 context 数字。
- 不复制任何工具 Schema。
- 明确以 runtime 实际提供的工具为准。
- 不硬编码用户、路径、日期或 Git 状态。
- 保留 Opus 4.8 lean prompt 的 Harness、沟通、Session guidance、Memory、Environment、Scratchpad 和 Context management 职责。
- 补充必要的 coding-agent、权限、工作树保护和验证规则。
- 适用于当前 `cc-haha` 与官方 Claude Code 的共同子集。

但它不是官方 Opus 4.8 prompt 的逐字副本，也不能静态复刻 Memory 路径、Environment、MCP、Skills、feature flags 和工具池等动态段。完全替换还意味着以后 Claude Code 默认 prompt 的改进不会自动生效。它适合受控实验或明确需要自定义 harness 的场景，不是日常默认推荐。

## 6. 对上下文窗口的实际影响

### 6.1 `/test` Claude.ai 文件

109 KB 的文件估计会占用数万 input tokens，而且其中很多内容与 coding 无关。真实工具 Schema 还会另行计入上下文，因此不是“用 Markdown 代替工具 Schema”，而是两份同时存在。

### 6.2 Claude Code 捕获文件

`claude-code-opus-4.8.md` 约 133 KB，包含工具定义。如果把它作为 system prompt 再注入，当前 `cc-haha` 仍会在 `tools` 字段发送真实工具，重复部分更明显。

### 6.3 新生成的清洗版 lean 替换文件

新文件以 Opus 4.8 lean system 首段为基准，保留稳定职责并移除捕获者路径、固定环境、Session Context、Agents、Skills 和 Tools 抓包。二次审查后恢复了完整的 Memory frontmatter、类型、索引、去重和过期校验职责，当前为 10,882 字符。它是可移植的运行时适配版本，不以长度等于捕获首段为目标。具体 token 数仍应以目标模型的 Token Counting API 或 Claude Code `/context` 为准。

Prompt caching 可以降低重复输入的部分费用和延迟，但缓存内容仍占 context window。

## 7. 验证建议

### 7.1 三组对照

使用相同仓库、相同任务和全新会话：

```text
A. claude --model claude-opus-4-8
B. claude --model claude-opus-4-8 --system-prompt-file 新生成的精简文件
C. claude --model claude-opus-4-8 --system-prompt-file /test/CLAUDE-FABLE-5.md
```

比较：

- `/context` 初始 system prompt 和 tools 占用。
- 实际响应 model ID。
- Bash/Read/Edit/Write 工具成功率。
- 是否生成 `/mnt/user-data` 等错误路径。
- 是否提到不存在的 Claude.ai 工具。
- 自动压缩发生时间。
- 完成质量、测试执行和最终报告准确性。

### 7.2 必须使用新会话

System prompt 是会话级前缀。不要在恢复旧会话时比较，否则历史消息、thinking blocks、缓存和模型切换会干扰结果。

### 7.3 不要用自然语言身份自报判断模型

System prompt 可以让 Opus 自称 Fable。应查看 CLI 模型状态、结构化输出或 API 响应的 `message.model`。

## 8. 最终判断

### “是否真的会发生工具不匹配”

会，但机制是：

```text
Claude.ai 工具说明作为普通 system 文本进入上下文
                    +
cc-haha 真实工具通过 API tools 字段进入上下文
                    =
两套工具语义冲突
```

不是 Claude.ai 的地图、天气和 Artifacts 工具真的被 Claude Code 注册。

### “Opus 4.8 应该跟哪个 Markdown”

优先答案：不跟任何文件，使用官方默认 prompt。

必须替换时：使用本报告生成的 `Claude-Code-Opus-4.8替换系统提示词.md`，不要使用目录中的完整泄露抓取。

### “能否复制 Claude Code Opus 4.8 抓取文件”

不建议。它是研究证据，不是可移植配置。正确的长期方案是让运行时动态生成 prompt 和 tools，而不是把一次会话抓包冻结成静态 Markdown。

## 9. 关键源码索引

- `src/main.tsx:989`：CLI prompt 参数。
- `src/main.tsx:1346`：读取 system prompt 文件。
- `src/utils/systemPrompt.ts:28`：提示优先级说明。
- `src/utils/systemPrompt.ts:115`：custom prompt 替换默认 prompt。
- `src/constants/prompts.ts:458`：默认 system prompt 动态构造。
- `src/tools.ts:194`：基础工具池。
- `src/tools.ts:272`：真实启用工具过滤。
- `src/utils/api.ts:119`：工具转换为 API Schema。
- `src/services/api/claude.ts:1764`：system 与 tools 独立发送。
- `src/screens/REPL.tsx:2769`：interactive context 构造。
- `src/utils/queryContext.ts:34`：headless custom prompt 行为。

## 10. 外部资料

- [Claude Code CLI system prompt flags](https://code.claude.com/docs/en/cli-usage#system-prompt-flags)
- [Claude Agent SDK modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

`system_prompts_leaks` 中的非官方抓取只能作为逆向分析证据。它们可能包含个人信息、动态会话状态、未启用 feature、旧版本内容或未经验证的修改。
