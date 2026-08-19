# Claude Code 自定义 Fable 提示词与上下文窗口分析

> 分析日期：2026-07-20
>
> 本机 Claude Code：`2.1.215`
>
> 分析对象：`/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md`

## 1. 结论先行

执行：

```bash
claude --system-prompt-file /Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md
```

不会改变模型的物理上下文窗口，也不会把 Opus 4.8 或 Sonnet 变成 Fable 5。但它会产生两类明显影响：

1. **上下文被长期占用**：该文件约 107 KB，粗略估计在 Fable 5/Opus 4.8 的新 tokenizer 下约占 3 万至 4 万 token。系统提示词会参与每一轮请求，因此会减少可用于代码、工具结果、对话历史和输出的空间。
2. **Claude Code 默认行为被整体替换**：`--system-prompt-file` 不是追加，而是替换 Claude Code 的完整默认系统提示词。默认的 coding-agent 身份、工具使用指导、安全规则、终端输出约定和代码规范都会被移除。

第二点比 token 占用更值得担心。这个文件从内容上看是一个 **Claude.ai/Claude App 的 Fable 5 产品提示快照**，不是 Claude Code 的 Fable 5 coding-agent prompt。直接放进 Claude Code 会让模型收到大量不存在或不匹配的工具、文件路径、Artifacts、地图、天气、连接器和 Web UI 指令。

因此不建议把这个原始文件作为 Claude Code 的完整 system prompt。若只是想借鉴其中的工作风格，应提炼成一个很短的附加提示，并使用：

```bash
claude --append-system-prompt-file ./fable-style-short.md --model opus
```

若要使用真正的 Fable 5，仍然必须显式选择模型并且账号具备服务端访问资格：

```bash
claude --model fable
```

提示词只能改变行为倾向，不能替换模型权重、推理能力、服务端路由、上下文规格或账号权限。

## 2. 本地文件审计

### 2.1 文件规模

本机检查结果：

| 项目 | 数值 |
| --- | ---: |
| 文件大小 | 109,327 bytes，约 107 KB |
| 行数 | 1,529 |
| 空白分隔词数 | 15,514 |
| SHA-256 | `3481aa1972c10a830d8c117da4c2483d4e891057acc1c157c096a227625e550d` |

空白分隔词数不是模型 token 数。JSON Schema、路径、代码、标点和复合标识符通常会拆成多个 token，必须针对实际模型调用 Anthropic Token Counting API 才能获得可靠估算。

### 2.2 它更像 Claude.ai 提示词，而不是 Claude Code 提示词

文件包含以下产品特征：

- 明确声称运行在 Claude Web 或移动端界面。
- Claude.ai 的 Memory、Artifacts 和持久化 Storage API。
- `/mnt/user-data/uploads`、`/mnt/user-data/outputs` 等托管沙箱路径。
- `places_search`、地图展示、天气、连接器推荐等工具定义。
- Claude.ai 的 Web Search、Web Fetch、引用和版权规则。
- 在 Artifact 中调用 Anthropic API 的产品专用说明。
- Claude.ai 的设置、样式、Research 和历史对话能力。

Claude Code 的真实运行环境是本机仓库、Shell、文件编辑、MCP、权限系统和终端界面。两者的 surface、工具名、参数 Schema、文件系统与人工确认机制不同。

把 Claude.ai 工具的 JSON 定义写入 system prompt，只是给模型一段描述，**不会在 Claude Code 中注册这些工具**。实际工具是否存在仍由 Claude Code 发给 API 的工具定义决定。这会导致模型尝试遵守不存在的能力，或把 Claude.ai 工具与 Claude Code 的真实工具混淆。

### 2.3 来源完整性不能确认

该本地文件与目前公开传播的 `elder-plinius/CL4R1T4S` 版本不是同一个字节版本：

| 文件 | 大小 | 行数 | SHA-256 |
| --- | ---: | ---: | --- |
| 本地文件 | 109,327 bytes | 1,529 | `3481aa...e550d` |
| 2026-07-20 获取的公开版本 | 122,750 bytes | 1,597 | `1ef125...7a897` |

这可能是不同提取版本、经过裁剪的版本，或者后来被编辑过的版本。仅凭标题不能证明它是 Anthropic 的完整原文，也不能证明未被第三方修改。

快速静态扫描没有发现零宽字符、双向文本控制字符、明显的数据外传命令或危险 Shell 命令。文件中的 URL 域名主要是 Anthropic、Claude 文档、cdnjs 和示例域名。但这只是有限的正则扫描，不等同于完整安全审计，也不能证明内容可信。

## 3. `--system-prompt-file` 到底做了什么

Anthropic 当前 CLI 文档明确区分四个参数：

| 参数 | 行为 |
| --- | --- |
| `--system-prompt` | 用给定字符串替换默认提示词 |
| `--system-prompt-file` | 用文件内容替换默认提示词 |
| `--append-system-prompt` | 追加到默认提示词后面 |
| `--append-system-prompt-file` | 把文件内容追加到默认提示词后面 |

官方还明确说明，替换默认提示词会丢掉 Claude Code 的默认工具指导、安全说明和 coding conventions；使用者需要自己承担重新提供这些内容的责任。

因此该命令的实际结构是：

```text
Claude Code 默认完整系统提示词
          ↓ 被替换
CLAUDE-FABLE-5.md 全文
          +
Claude Code 实际注册的工具、会话消息和运行环境
```

它不是：

```text
Claude Code 默认提示词 + Fable 优化补丁
```

若只是想增加风格、输出格式或额外约束，官方推荐的是 append 方式，因为它保留默认 coding-agent 能力。

## 4. 会不会导致“上下文窗口异常”

### 4.1 不会修改模型的窗口上限

系统提示词无法把 200K 模型变成 1M，也不会把 1M 模型降成 200K。窗口规格由实际响应模型和服务端决定。

Anthropic 当前文档列出的规格包括：

- Claude Opus 4.8：1M context。
- Claude Sonnet 5：1M context。
- Claude Fable 5：1M context，单次最多 128K output。

但是模型窗口的所有内容共享同一个预算：system prompt、消息历史、工具定义、工具结果、图片/文档、当前输出和 extended thinking 都会占用上下文。

### 4.2 它会制造固定的 token 税

Anthropic 说明 Fable 5、Opus 4.7 及之后的 Opus、Sonnet 5 使用新的 tokenizer。同一段文字相对于较早模型可能产生大约 30% 更多 token，具体比例取决于内容，不能沿用旧模型的计数。

基于文件的 109 KB 规模、英文说明、代码和大量 JSON Schema，合理的非权威估算是：

```text
约 30,000 至 40,000 input tokens
```

粗略占比：

| 模型窗口 | 该文件可能占用 | 影响 |
| ---: | ---: | --- |
| 1M | 约 3% 至 4% | 不会立即溢出，但每轮永久占用这部分空间 |
| 200K | 约 15% 至 20% | 明显挤压代码、工具结果和长会话空间 |

Claude Code 还会发送真实工具定义、`CLAUDE.md`、环境信息和对话历史，所以实际初始占用一定高于这个文件本身。

### 4.3 Prompt cache 不会归还上下文空间

如果稳定的 system prompt 命中 prompt cache，后续请求的费用和延迟可能下降。但是 Anthropic 明确说明：

> 缓存的 prompt prefix 仍然占据 context window；缓存改变计费和处理方式，不改变窗口占用。

所以即使 3 万至 4 万 token 被缓存，它们仍然会减少可用于当前会话的剩余上下文。

### 4.4 用户可能观察到的“异常”

它通常不会表现为窗口数字被错误修改，而更可能表现为：

1. `/context` 一开始就显示比普通会话更高的占用。
2. 长任务更早触发自动压缩或要求 `/compact`。
3. Prompt cache 首次创建更慢，首次输入额度消耗更大。
4. 模型更容易被无关的 Claude.ai 产品规则分散注意力。
5. 工具调用出现错误名称、错误参数或错误文件路径。
6. 模型声称自己是 Fable 5，但响应元数据仍然显示实际选择的 Opus/Sonnet。
7. 提示词中的旧日期、旧能力描述和当前 CLI 行为冲突。

因此，“上下文上限异常”并不是准确描述；更准确的是：**一个超大的、跨产品且不匹配的 system prompt 持续占用上下文，并破坏 Claude Code 默认脚手架。**

## 5. 它能不能让 Opus 4.8 变成 Fable 5

不能。

需要区分以下四层：

| 层次 | 由什么决定 | 该 Markdown 能否改变 |
| --- | --- | --- |
| 模型权重 | `--model`、请求 model ID、服务端路由 | 不能 |
| 上下文和输出规格 | 实际服务模型 | 不能 |
| Thinking、effort、拒绝和 fallback 协议 | 模型能力与服务端策略 | 不能 |
| 语言风格、任务习惯、自我描述 | System prompt 和会话指令 | 可以部分改变 |

如果使用：

```bash
claude --model opus --system-prompt-file CLAUDE-FABLE-5.md
```

实际仍然是 Opus。提示词可能让 Opus 自称 Fable，也可能模仿部分表达风格和工作习惯，但不会获得 Fable 的权重、推理能力、分类器、服务端功能或定价资格。

验证实际模型应查看 Claude Code 的模型状态、结构化输出或 API 响应元数据，不能让模型通过自然语言自报身份。

## 6. Opus、Sonnet、Fable 的提示词是否各不相同

答案是：**存在大量共享部分，也存在按模型、代际、能力和产品 surface 选择的差异；不是三份完全独立的静态大文件。**

### 6.1 先区分 Claude.ai 与 Claude Code

Anthropic 官方的 System Prompts 页面说明，它发布的是 Claude.ai 和移动 App 的核心 system prompt，这些更新不适用于裸 Claude API。该页面分别列出了 Fable 5、Opus 4.8、Opus 4.7、Sonnet 4.6 等模型的条目，说明消费端产品至少存在按模型维护的核心差异。

而 Claude Code 是另一个产品。它需要额外的：

- coding-agent 身份和工作方式。
- Bash、Read、Edit、MCP 等工具指导。
- 权限与安全规则。
- Git、仓库、工作目录和环境信息。
- Plan、subagent、memory、hooks、skills 等条件片段。

因此，Claude.ai 的 Fable 提示快照不能被视为 Claude Code 的 Fable prompt。

### 6.2 Claude Code 的提示词是动态拼装的

Claude Code 不是简单地为每个模型保存一个永远不变的 `opus.md`、`sonnet.md` 和 `fable.md`。它会根据以下条件拼接或选择提示片段：

- 模型家族和版本。
- 是否使用 lean prompt。
- 当前工具集合和 MCP。
- 权限模式、Plan Mode、auto mode。
- 是否启用 Chrome、skills、hooks、memory、agents。
- 操作系统、Shell、工作目录和 Git 状态。
- 主代理、subagent、compaction 或其他内部任务。

官方 Claude Code `2.1.154` 变更记录明确写到：lean system prompt 已成为新版模型的默认选择，但 Haiku、Sonnet 和 Opus 4.7 及更早版本例外。这证明 Claude Code 确实根据模型或模型代际选择不同的主提示变体。

第三方对 Claude Code `2.1.215` 编译产物的提取还显示存在一个约 177 token 的 Fable 5 专属身份片段，同时大量 harness、工具和编码规则由不同条件片段组合。这个提取结果不是 Anthropic 官方源码，应作为辅助证据，而不是绝对事实来源。

### 6.3 Fable 5 的确更特殊，但不只特殊在提示词

Fable 5 与 Opus 4.8 的重要区别主要来自模型与服务协议，而不是靠那份 107 KB prompt 创造出来的：

- Fable 5 的 adaptive thinking 始终开启，不能显式 disabled。
- Fable 5 有额外的安全分类器与拒绝类别。
- 某些请求会从 Fable 5 自动切换到 Opus 4.8。
- Thinking block、跨模型历史和 fallback 有专门处理规则。
- Fable 5 有特定的数据保留要求。

Opus 和 Sonnet 也有各自特殊点。例如 Opus 4.8 可以在省略 thinking 配置时不开启 thinking；Sonnet 5 有自己的 prompting guidance 和 context-awareness 行为。Anthropic 官方 Prompting Best Practices 已经分别提供 Fable 5、Sonnet 5 和 Opus 4.8 的模型专项建议。

所以更准确的结论是：

```text
共享 Claude Code 核心 prompt
  + 按模型/代际选择的 prompt 片段
  + 按工具、环境、权限、模式选择的动态片段
  + 服务端模型本身的能力和安全协议
```

Fable 不是唯一有专属适配的模型，只是它在 thinking、安全分类、fallback 和数据策略上的差异更大。

## 7. 该文件在 Claude Code 中的具体风险

### 7.1 工具和路径错配

提示词会要求使用 Claude.ai 专属工具与路径，而 Claude Code 可能只提供名称和 Schema 不同的工具。常见后果包括：

- 尝试调用不存在的 `places_search`、`weather_fetch` 等工具。
- 把输出写到不存在或不适合本机的 `/mnt/user-data/outputs`。
- 错误假设 Claude.ai Artifact Storage API 存在。
- 把普通本机文件任务当成 Claude.ai 上传文件流程。
- 真实 Claude Code 工具仍在，但默认使用指导已经被替换。

### 7.2 指令冲突和能力幻觉

文件让模型相信自己位于 Claude.ai，并拥有 Claude.ai 的产品能力。Claude Code 则把真实工作目录、真实工具和会话状态交给模型。这两套事实冲突时，模型可能：

- 在两个运行环境之间摇摆。
- 输出无法执行的工具调用建议。
- 对不存在的 UI、设置或连接器作出承诺。
- 错误报告模型身份或能力。

### 7.3 安全边界被削弱

替换 system prompt 会移除 Claude Code 默认的工具、安全和 permission guidance。CLI 自身及服务端仍有独立安全机制，但不应该因为它们存在，就主动删掉模型侧的默认指导。

尤其不要照搬网上常见命令中的：

```bash
--dangerously-skip-permissions
```

这个参数不会提高模型能力，也不会解锁 Fable；它只会减少本机工具执行前的人工确认。将来源不完全可验证的超长提示与跳过权限同时使用，会扩大本机文件、命令和凭据风险。

### 7.4 可能影响 Fable 的安全 fallback

Anthropic 说明 Fable 5 的安全检查会审查模型读取到的全部内容，不只审查最新用户消息，还包括文件、记忆、连接器和搜索结果。一个包含大量安全、模型身份、reasoning 和工具说明的第三方 prompt 可能增加分类器输入噪声。

不能断言它一定触发 fallback，但如果 Fable 会话莫名切到 Opus 4.8，应先用全新会话和 Claude Code 默认 prompt 做对照，而不是假定是上下文窗口 bug。

## 8. 推荐的使用方式

### 8.1 最推荐：不用原始文件

直接使用 Claude Code 默认提示词和真实模型：

```bash
claude --model fable
```

或：

```bash
claude --model opus
```

官方 CLI 已经会按照当前版本、模型和环境选择适合的提示片段。

### 8.2 只想借鉴风格：提炼后追加

从原始文件中只提炼与目标有关的通用行为，例如：

- 长任务先收集上下文并持续验证。
- 明确报告进度，不虚构完成状态。
- 根据任务复杂度调整解释长度。
- 工具失败时检查结果并修正策略。

把这些规则控制在数百到一两千 token，而不是复制工具 Schema、产品身份、安全政策、Claude.ai 路径和内部产品说明。然后使用：

```bash
claude --append-system-prompt-file ./fable-style-short.md --model opus
```

append 会保留 Claude Code 的默认工具、安全与编码指导，是风险更低的定制方式。

### 8.3 做对照实验

若想判断提示词是否真的提高效果，应至少比较：

| 实验组 | 模型 | System prompt |
| --- | --- | --- |
| A | Opus 4.8 | Claude Code 默认 |
| B | Opus 4.8 | 默认 + 精简追加提示 |
| C | Opus 4.8 | 原始 107 KB 完整替换，仅用于受控测试 |
| D | Fable 5 | Claude Code 默认 |

实验要求：

1. 每组使用全新会话，避免历史污染。
2. 使用同一个仓库快照和同一任务。
3. 不启用 `--dangerously-skip-permissions`。
4. 记录 `/context` 初始占用。
5. 记录实际响应模型，而不是询问模型“你是谁”。
6. 比较完成率、工具错误、修改质量、耗时、输入 token 和压缩次数。
7. 至少重复数次，不能用一次主观体验下结论。

如果 C 组表现更像 Fable，只能说明提示词改变了 Opus 的行为风格，不能说明它获得了 Fable 的模型能力。

## 9. 最终判断

### 关于上下文

该文件不会损坏或修改上下文窗口上限，但会占用约数万 token，并可能导致更早压缩、更高首次输入成本和更差的有效上下文利用率。对 1M 模型不是立即致命，对 200K 模型则是明显负担。

### 关于 Claude Code 行为

完整替换默认 prompt 的风险高于 token 成本。这个文件属于 Claude.ai 产品环境，和 Claude Code 的工具、路径、权限及输出 surface 不匹配，容易造成行为异常。

### 关于模型提示词差异

Claude Code 的 Opus、Sonnet 和 Fable 共享大量 coding-agent 核心规则，但会按模型代际与能力选择不同片段；此外还会根据工具、权限和环境动态拼装。Fable 有专属身份和协议适配，但不是唯一使用特殊提示配置的模型。

### 最务实的选择

```text
要真正的 Fable 能力：选择真实 Fable 模型。
要 Fable 风格：提炼少量通用规则并 append。
不要：用 Claude.ai 的 107 KB 泄露提示完整替换 Claude Code prompt。
更不要：同时启用 --dangerously-skip-permissions。
```

## 10. 参考资料

### Anthropic 官方

- [Claude Code CLI reference：System prompt flags](https://code.claude.com/docs/en/cli-usage#system-prompt-flags)
- [Claude Agent SDK：Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Claude Platform：Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Claude Platform：Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Claude Platform：System Prompts release notes](https://platform.claude.com/docs/en/release-notes/system-prompts)
- [Claude Platform：Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Claude Platform：Model migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [为什么 Fable 5 会切换到其他模型](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5)

### 非官方材料，仅作来源识别和辅助证据

- [当前公开传播的 CLAUDE-FABLE-5.md](https://github.com/elder-plinius/CL4R1T4S/blob/main/ANTHROPIC/CLAUDE-FABLE-5.md)
- [Piebald-AI：从 Claude Code 编译产物提取的提示片段](https://github.com/Piebald-AI/claude-code-system-prompts)
- [对公开 Fable prompt 的第三方规模分析](https://www.ayautomate.com/resources/claude-code-challenge/day-52)

非官方提取材料可能不完整、被修改或随产品版本过期。关于 CLI 行为、上下文、模型协议和安全策略的判断应以 Anthropic 官方文档与实际响应元数据为准。
