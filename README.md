# Claude Code Haha Lala

这是 [`NanmiCoder/cc-haha`](https://github.com/NanmiCoder/cc-haha) 的个人下游 Fork，用于保留本地功能改造、模型与 Provider 适配、Claude Code Prompt 研究，以及会话 JSONL/Compact 机制分析。

本仓库不是上游项目的官方发行版。上游原始中文介绍已保存为 [README.upstream.md](README.upstream.md)，英文介绍见 [README.en.md](README.en.md)。

## 仓库关系

| 角色 | GitHub 仓库 | Git remote |
| --- | --- | --- |
| 下游可写仓库 | [`we1005/claude-code-haha-lala`](https://github.com/we1005/claude-code-haha-lala) | `origin` |
| 上游来源 | [`NanmiCoder/cc-haha`](https://github.com/NanmiCoder/cc-haha) | `upstream` |

推荐的本地配置：

```bash
git remote set-url origin git@github.com:we1005/claude-code-haha-lala.git
git remote get-url upstream >/dev/null 2>&1 || \
  git remote add upstream https://github.com/NanmiCoder/cc-haha.git
git fetch origin
git fetch upstream --tags
```

Git remote 不会随 clone 自动传播。后续维护者和 Agent 应遵循 [AGENTS.md](AGENTS.md#upstream-repository-workflow) 中的同步规则。

## 上游特性同步

本仓库与上游存在有意保留的差异，不应默认整体 merge 或 rebase `upstream/main`。同步某项功能时，先检查提交，再在独立分支中摘取：

```bash
git fetch upstream --tags
git log --oneline --decorate main..upstream/main
git show <upstream-commit>

git switch -c sync/upstream-<feature>
git cherry-pick <upstream-commit>
```

提交或 PR 中应记录摘取的上游 commit ID，并重点复核模型路由、Provider runtime、OAuth、Prompt、持久化格式和 Agent loop 冲突。

## 本仓库内容

### Claude Code Haha

项目主体是一个 Bun 驱动的 Coding Agent 产品，包含 CLI、本地服务、Tauri 桌面端、IM adapters、Provider/OAuth 集成、MCP、Skills、Computer Use 和文档站点。完整产品介绍、截图和安装说明见 [上游 README](README.upstream.md)。

### Prompt 与模型兼容性研究

仓库根目录保留了针对以下主题的 Markdown 分析和实验性替换 Prompt：

- Opus、Sonnet、Fable 不同版本的系统提示词结构与兼容性；
- `--system-prompt-file` 的全量替换边界；
- cc-haha 从 Opus 4.6/4.7 到后续模型的适配路径；
- Anthropic 官方订阅、OAuth、Provider 与模型 ID 路由；
- Claude Code Prompt 的公共部分、模型差异部分和动态注入内容。

这些文档是研究记录，不代表 Anthropic 或上游项目的官方说明。涉及版本能力时，应结合目标日期、服务端授权结果和上游最新代码重新验证。

### Compact Summary 与 JSONL

仓库包含 Claude Code Compact、Session 恢复、JSONL transcript 和消息角色机制的分析文档，以及独立工具 [jsonl-analysis-tool](jsonl-analysis-tool/README.md)。该工具可在浏览器本地完成：

- 流式扫描大型 Claude Code JSONL 会话；
- 定位 `isCompactSummary: true` 记录；
- 将 `message.content` 解码为可编辑多行文本；
- 只替换 Content 对应的 JSON AST 范围；
- 校验输出仍为一个合法 JSONL 物理行，且其他字段不变。

## 本地运行

需要安装 [Bun](https://bun.sh/)：

```bash
bun install
./bin/claude-haha
```

也可以使用：

```bash
bun run start
```

常用检查：

```bash
bun run check:impact
bun run check:server
bun run check:desktop
bun run verify
```

JSONL 工具独立运行：

```bash
cd jsonl-analysis-tool
bun install
bun run dev
```

## 本地数据与凭据

不要提交以下内容：

- `node_modules/` 和本地构建产物；
- `.env`、API Key、OAuth Token、Cookie 和私钥；
- `~/.claude/cc-haha/*oauth*.json`、`providers.json`、`settings.json`；
- `~/.claude/projects/**/*.jsonl` 原始会话文件；
- `.claude/`、运行时缓存、质量报告和浏览器临时输出。

提交分析报告前，应检查其中是否包含真实凭据、邮箱、私有仓库地址或不希望公开的本机路径。

## 许可证与来源

本仓库沿用项目现有的 [LICENSE](LICENSE)。上游来源、原始功能说明和发布信息以 [`NanmiCoder/cc-haha`](https://github.com/NanmiCoder/cc-haha) 为准。
