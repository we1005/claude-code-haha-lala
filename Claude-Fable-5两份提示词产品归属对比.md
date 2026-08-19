# Claude Fable 5 两份提示词产品归属对比

## 1. 分析对象

本文比较以下两个文件：

```text
/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md
/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/Claude Code/claude-code-fable-5.md
```

需要回答的问题是：

1. 两个文件是否相同。
2. `/test/CLAUDE-FABLE-5.md` 是否为 Claude.ai 提示词。
3. 两个文件是否都属于 Claude Code。
4. 哪一个适合作为 `claude --system-prompt-file` 的参考来源。

## 2. 结论

两个文件不相同，也不属于同一个产品：

| 文件 | 产品语义 | 判断 |
| --- | --- | --- |
| `/Volumes/zhitai-7100/test/CLAUDE-FABLE-5.md` | Claude.ai / Claude App | Claude.ai 聊天产品的 Fable 5 提示词快照或整理版本 |
| `/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/Claude Code/claude-code-fable-5.md` | Claude Code | Claude Code Fable 5 的完整会话捕获 |

简化表达如下：

```text
/test/CLAUDE-FABLE-5.md
= Claude.ai / Claude App 提示词
!= Claude Code 提示词

Anthropic/Claude Code/claude-code-fable-5.md
= Claude Code 提示词及会话上下文捕获
```

`/test/CLAUDE-FABLE-5.md` 中出现 Bash、文件操作、Artifacts 和 Claude Code
产品介绍，不代表它属于 Claude Code。Claude.ai 本身也提供代码执行、文件创建、
Artifacts、连接器和搜索能力，而且其产品信息段会介绍 Claude Code。

## 3. 字节级比较

两个文件的 SHA-256、行数和大小均不同：

| 文件 | SHA-256 | 行数 | 单词数 | 字节数 |
| --- | --- | ---: | ---: | ---: |
| `/test/CLAUDE-FABLE-5.md` | `3481aa1972c10a830d8c117da4c2483d4e891057acc1c157c096a227625e550d` | 1,529 | 15,514 | 109,327 |
| `Claude Code/claude-code-fable-5.md` | `a41caa5083c08fd601e72482b76c96613d83622acb08ac8a6d0aea0b60c95cd4` | 2,546 | 20,196 | 140,769 |

`cmp` 的结果为不相同。因此它们不是同一文件的改名副本，也不是只有路径不同。

`/test/CLAUDE-FABLE-5.md` 与泄露目录根部的
`Anthropic/claude-fable-5.md` 也不是字节相同的文件。这说明 `/test` 文件更可能是
另一个日期、另一次捕获或经过整理的 Claude.ai 提示快照，不能仅凭文件名判断其
具体捕获版本。

## 4. `/test/CLAUDE-FABLE-5.md` 的产品特征

该文件没有将自己定义为 Claude Code CLI，而是具有明显的 Claude.ai / Claude App
运行环境特征。

### 4.1 将当前环境定义为聊天界面

文件第 16 行写明 Claude 运行于：

```text
this web-based, mobile, or desktop chat interface
```

这是 Claude.ai 网页、移动端和桌面聊天产品的描述，不是终端 CLI harness。

### 4.2 将 Claude Code 作为另一个产品介绍

文件第 20 行使用：

```text
Claude is accessible through Claude Code, an agentic coding tool...
```

这段话是在介绍用户还可以通过 Claude Code 使用 Claude。它将 Claude Code 视为
另一个入口，而不是声明当前运行环境就是 Claude Code。

### 4.3 包含 Claude.ai 专属或典型功能

文件包含以下部分：

- Claude.ai 设置、模型切换和聊天风格。
- Claude.ai Artifacts 及 `window.storage` 持久化接口。
- MCP App 推荐和连接器选择。
- 地点搜索与地图展示。
- 天气、体育、菜谱和消息撰写工具。
- Web Search、Image Search 和网页抓取。
- Claude.ai 文件生成、预览和向用户展示文件的规则。
- Claude.ai User Context、可用 Skills、网络及文件系统配置。

特别是 `places_map_display_v0`、`weather_fetch`、`recommend_claude_apps`、
`suggest_connectors` 和 Artifacts 浏览器存储说明，与 Claude Code 的仓库型编码
agent harness 不对应。

### 4.4 缺少 Claude Code 核心开场结构

该文件开头没有以下 Claude Code 身份声明：

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

它也没有以 Claude Code 的 `Harness`、`Session-specific guidance`、Git 仓库、
CLI 权限模式和终端输出规范作为核心开场。

因此，从内容和结构上都应将它归为 Claude.ai / Claude App 提示词，而不是
Claude Code 提示词。

## 5. `claude-code-fable-5.md` 的产品特征

该文件从第一部分开始就明确属于 Claude Code。

### 5.1 明确身份声明

第 3 行写明：

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

随后将模型定义为帮助用户完成软件工程任务的交互式 agent。

### 5.2 Claude Code harness

文件紧接着包含：

- 终端中的 GitHub-flavored Markdown 输出。
- 用户选择的权限模式和拒绝工具调用后的行为。
- Hooks 对工具调用的拦截。
- 文件、搜索和 shell 工具的选择规则。
- `file_path:line_number` 形式的代码引用。
- 开始工具调用前和执行过程中的用户进度更新。

这些都是 Claude Code agent loop 和终端交互约束。

### 5.3 动态会话组成

该文件还包含：

- `Memory`
- `Environment`
- `Scratchpad Directory`
- `Context management`
- `Session context`
- `gitStatus`
- `claudeMd`
- `userEmail`
- `currentDate`
- `Agents`
- `Skills`
- `Tools`

这说明它不只是一个纯静态 system prompt，而是一次 Claude Code 会话中 system
prompt、动态上下文和工具 Schema 的合并捕获。

### 5.4 编码工具与 agent 工具

工具部分包含 `Bash`、`Edit`、`Read`、`Write`、`NotebookEdit`、计划模式、
worktree、任务管理、子 agent、Skill 和 Git 操作等 Claude Code 工具。

所以，该文件的产品归属明确是 Claude Code。

## 6. 泄露目录 README 的分类证据

`/Volumes/zhitai-7100/system_prompts_leaks/Anthropic/README.md` 明确规定：

```text
The bare claude-<model>.md files in this folder are the claude.ai system prompts.
Claude Code/ is Claude Code (the CLI/agent harness).
```

其分类表对应为：

| 文件模式或目录 | 产品 |
| --- | --- |
| `claude-fable-5.md`、`claude-opus-4.8.md` 等根目录裸文件 | Claude.ai |
| `Claude Code/` | Claude Code CLI/agent harness |
| `Official/` | Anthropic 公开发布的精简提示版本 |

`/test/CLAUDE-FABLE-5.md` 不在该泄露目录中，因此 README 不能直接证明它的
来源；但是它的内容结构与 README 所描述的 Claude.ai 类型一致。

## 7. 关于“泄露版”真实性的边界

本地文件内容足以判断它面向哪个产品，却不能单独证明：

- 文件确实直接来自 Anthropic 生产环境。
- 文件没有被第三方编辑、拼接或重新排版。
- 文件名中的模型与日期完全准确。
- 文件代表当前线上仍在使用的版本。

因此，本文中的“Claude.ai 提示词”和“Claude Code 捕获”是基于产品语义、结构以及
泄露库分类得出的判断，不等于对泄露来源真实性作密码学或官方背书。

`/test/CLAUDE-FABLE-5.md` 与泄露库根目录的 `claude-fable-5.md` 哈希不同，尤其
需要保留上述版本和编辑来源的不确定性。

## 8. 对 `--system-prompt-file` 的意义

### 8.1 使用 `/test/CLAUDE-FABLE-5.md`

技术上，`cc-haha` 会把它作为 UTF-8 文本读取并传入 custom system block，不会因为
它属于 Claude.ai 就自动拒绝。

但产品语义不匹配。模型会收到大量当前 Claude Code 环境不存在或不对应的说明，
包括地图、天气、Claude.ai Artifacts、连接器、聊天设置和 Claude.ai 文件呈现规则。
真实 Claude Code 工具仍由 API 的 `tools` 字段另行注册，因此这些文本不会替代或
创建相应工具。

结论：不适合作为 Claude Code 的替换系统提示词。

### 8.2 使用完整 `claude-code-fable-5.md`

它的 Claude Code 产品语义正确，而且 `--system-prompt-file` 能读取其 Markdown
文本。但完整文件同时包含捕获时的动态数据：

- 捕获者的 Memory 路径。
- 捕获时的 Git status 和 `CLAUDE.md`。
- 固定日期、OS、Shell 和模型描述。
- 未解析或捕获时的 scratchpad 状态。
- 当时的 Agents、Skills 和完整工具 Schema。

当前 `cc-haha` 仍会通过 API `tools` 字段发送自己的真实工具池，所以完整捕获中的
工具说明可能重复，也可能与实际注册工具不一致。

结论：适合研究和一次性对照，不适合长期作为可移植的默认替换文件。

### 8.3 推荐文件

当前仓库已经生成清洗后的 Claude Code Fable 5 替换提示词：

```text
/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Fable-5替换系统提示词.md
```

它保留 Claude Code Fable 5 的稳定职责，并去除了捕获者路径、固定会话状态、
Session Context、Agents、Skills 和工具 Schema。用于当前项目时，比直接注入以上
两个完整文件更合适。

示例：

```bash
claude \
  --model claude-fable-5 \
  --system-prompt-file "/Volumes/zhitai-7100/personal/cc-haha/Claude-Code-Fable-5替换系统提示词.md"
```

这个参数只替换或影响 system prompt 文本，不会解锁模型。`claude-fable-5` 是否
真正可用，仍取决于 CLI 发送的 model ID、当前 provider/OAuth 路由以及 Anthropic
服务端对订阅账号开放的模型权限。
