# cc-haha 对 Claude Opus 4.8 与 Fable 5 的兼容性分析

> 分析日期：2026-07-20
>
> 分析范围：本地仓库、`origin/main`、Anthropic 官方文档、Claude Code 官方变更记录、cc-haha 上游 Issue/PR
>
> 说明：本文不包含 OAuth Token、API Key、Cookie 或 Provider 密钥等敏感信息。

## 1. 执行摘要

本次分析的核心结论如下：

1. 截至分析时，上游最新提交 `100a2b25b8b4e3cc14875209654aaf9a63b2c59d` 仍将官方默认模型硬编码为 `claude-opus-4-7`，官方模型列表也没有 Opus 4.8、Sonnet 5 或 Fable 5。
2. 如果同时把官方默认模型 ID 和模型列表中的 Opus ID 改为 `claude-opus-4-8`，桌面端选中的 ID 会通过 `--model claude-opus-4-8` 进入内核，最终请求体也会携带 `"model": "claude-opus-4-8"`。
3. Anthropic 将 `claude-opus-4-8` 定义为固定模型快照。如果官方服务接受这个请求，且响应中的 `message.model` 也是 `claude-opus-4-8`，那么实际调用的就是 Opus 4.8，而不是只把 4.7 改了显示名称。
4. 但是，只改模型字符串不能让旧内核获得完整的 Opus 4.8 支持。当前内核会错误识别 4.8 的能力，涉及 adaptive thinking、effort、1M 上下文、128K 输出、模型显示、成本估算和 thinking block 兼容性。
5. Opus 4.8 可以做一个有明确边界的兼容补丁；Fable 5 不能照搬这个补丁。Fable 5 还有强制 adaptive thinking、模型绑定的 thinking signature、拒绝与安全回退、订阅/usage credits 和最低客户端版本等额外约束。
6. 在上游 Issue、PR 和活跃 Fork 范围内，没有发现已经合并并经过官方 OAuth 验证的完整 Opus 4.8/Fable 5 兼容方案。

一句话总结：

> 只改模型 ID，有机会立即调用到真正的 Opus 4.8，但这只能算实验性模型路由支持，不能算完整、稳定的 Opus 4.8 客户端支持。

## 2. 仓库与版本基线

分析时的版本状态：

| 项目 | 值 |
| --- | --- |
| 本地 HEAD | `a159ee3511e718e006844b4329fd08ef4d232802` |
| 上游 `origin/main` | `100a2b25b8b4e3cc14875209654aaf9a63b2c59d` |
| 上游提交时间 | 2026-07-18 20:25:42 +08:00 |
| 本地落后上游 | 578 commits |
| 本机官方 Claude Code | `2.1.215`，路径 `/Users/admin/.local/bin/claude` |
| cc-haha 声明的兼容版本 | `2.1.92` |

上游最新版本仍然包含：

```ts
export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-7'

export const OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    context: '1m',
  },
  // ...
]
```

对应文件：

- `desktop/src/constants/modelCatalog.ts`
- `src/utils/model/configs.ts`
- `src/utils/model/model.ts`
- `src/utils/effort.ts`
- `src/utils/thinking.ts`
- `src/utils/model/modelContextWindows.ts`
- `src/constants/claudeCodeCompatibility.ts`

## 3. 配置文件路径必须区分

cc-haha 自己管理的配置不是单纯读取 `~/.claude/settings.json`。

与当前问题相关的主要路径是：

| 路径 | 用途 |
| --- | --- |
| `~/.claude/cc-haha/settings.json` | cc-haha 管理的模型、环境变量和运行时设置 |
| `~/.claude/cc-haha/providers.json` | cc-haha Provider 配置 |
| `~/.claude/cc-haha/oauth.json` | cc-haha 官方 Anthropic OAuth 状态 |
| `~/.claude/settings.json` | 标准 Claude Code 用户设置，不等同于 cc-haha 管理设置 |

因此，判断当前模型时不能只查看或修改 `~/.claude/settings.json`。

同时还要注意：桌面端对某个会话设置的 runtime model override 优先级很高。即使磁盘配置中存在别的默认模型，只要桌面会话发送了 `set_runtime_config`，会话运行时仍会优先使用其中的 `modelId`。

## 4. 三层模型选择链路

必须把下面三层分开分析：

1. cc-haha 下拉列表显示什么模型。
2. cc-haha 实际向 CLI 和 Anthropic 请求发送什么 model ID。
3. Anthropic 服务端是否允许当前账号和客户端使用该模型，以及最终实际返回哪个模型。

### 4.1 第一层：桌面模型列表

官方模型列表来自：

```text
desktop/src/constants/modelCatalog.ts
```

这里同时定义：

- `OFFICIAL_DEFAULT_MODEL_ID`
- `OFFICIAL_MODELS`

如果只把：

```ts
name: 'Opus 4.7'
```

改成：

```ts
name: 'Opus 4.8'
```

那么只是修改显示名称，实际仍然请求 `claude-opus-4-7`。

至少应同时修改：

```ts
export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-8'

{
  id: 'claude-opus-4-8',
  name: 'Opus 4.8',
  description: 'Most capable for ambitious work',
  context: '1m',
}
```

只改 `OFFICIAL_DEFAULT_MODEL_ID` 而不改 `OFFICIAL_MODELS` 也不完整：默认值和可选列表会出现不一致。

### 4.2 第二层：runtime model ID

桌面连接会话后，会发送类似：

```json
{
  "type": "set_runtime_config",
  "modelId": "claude-opus-4-8"
}
```

服务端将这个 ID 保存为会话 runtime override，并在启动内核时生成：

```text
--model claude-opus-4-8
```

主要链路如下：

```text
desktop/src/stores/chatStore.ts
  -> WebSocket set_runtime_config
  -> src/server/ws/handler.ts
  -> RuntimeSettings.model
  -> src/server/services/conversationService.ts
  -> --model claude-opus-4-8
```

`ConversationService.getRuntimeArgs()` 的行为是：

```ts
if (options?.model) {
  args.push('--model', options.model)
}
```

所以模型 ID 不是停留在界面层，而是进入了实际 CLI 启动参数。

### 4.3 第三层：Anthropic 请求体

内核的模型解析逻辑允许未注册的完整模型 ID 原样通过：

```ts
return modelInputTrimmed
```

在最终请求前，`normalizeModelStringForAPI()` 只会移除 `[1m]` 或 `[2m]` 后缀：

```ts
export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
```

最终 Messages API 请求体来自：

```ts
return {
  model: normalizeModelStringForAPI(options.model),
  // ...
}
```

因此，当 runtime model 是 `claude-opus-4-8` 时，最终请求体会是：

```json
{
  "model": "claude-opus-4-8"
}
```

这条链路说明：模型 ID 的修改确实可以抵达 Anthropic 服务端。

## 5. 改成 `claude-opus-4-8` 后，究竟是不是 4.8

### 5.1 在什么条件下答案是“是”

必须同时满足：

1. 当前使用的是官方 Anthropic OAuth，而不是自定义 Provider 或第三方中转站。
2. 出站请求体中的 `model` 确实是 `claude-opus-4-8`。
3. Anthropic 账号当前有 Opus 4.8 权限和可用额度。
4. Anthropic 服务端接受这个客户端发出的请求。
5. 响应中 `message_start.message.model` 或最终 Message 的 `model` 是 `claude-opus-4-8`。

Anthropic 官方文档说明，从 4.6 代开始，类似 `claude-opus-4-8` 的无日期 ID 也是固定快照，不是自动指向其他模型的浮动别名。

所以：

> 请求和响应中的模型 ID 都是 `claude-opus-4-8`，就是实际 Opus 4.8，不能解释为“4.7 改名”。

### 5.2 为什么仍然不能称为完整支持

模型路由正确，不代表客户端理解该模型的全部协议和能力。

当前内核没有正式注册 Opus 4.8。它对 4.8 的处理会落入旧模型或未知模型分支，造成多处行为偏差。

## 6. 当前内核对 Opus 4.8 的具体兼容缺口

### 6.1 Canonical model 识别错误

`firstPartyNameToCanonical()` 没有 `claude-opus-4-8` 分支。

由于它后面存在：

```ts
if (name.includes('claude-opus-4')) {
  return 'claude-opus-4'
}
```

`claude-opus-4-8` 会被错误归一化为：

```text
claude-opus-4
```

这个错误会继续影响 thinking、effort、输出限制、成本、显示名称等逻辑。

### 6.2 Adaptive thinking 被判定为不支持

`modelSupportsAdaptiveThinking()` 当前明确识别的只有内部条件中的旧型号：

```ts
if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
  return true
}
```

随后所有包含 `opus`、`sonnet`、`haiku` 但不在允许列表内的模型都会返回 `false`。

由于 4.8 被 canonical 成 `claude-opus-4`，它会进入拒绝分支。后果是：

- 可能不发送 `thinking: { type: "adaptive" }`
- 模型可能在无 thinking 状态运行
- 对高难度编码任务的实际能力产生明显影响

Anthropic 官方迁移文档明确说明，Opus 4.8 支持 adaptive thinking，手工 budget thinking 不再是正确方案。

### 6.3 Effort 被判定为不支持

`modelSupportsEffort()` 目前没有 Opus 4.8 分支，并且遇到包含 `opus` 的未知版本时会返回 `false`。

这意味着旧内核可能不发送：

```json
{
  "output_config": {
    "effort": "high"
  }
}
```

Anthropic 官方说明：

- Opus 4.8 默认 effort 为 `high`
- 高难度编码和高自治任务可以显式使用 `xhigh`

即使 API 默认值让普通请求能够运行，cc-haha 仍无法完整提供或正确展示 4.8 的 effort 控制。

### 6.4 本地上下文窗口错误回退到 200K

`src/utils/model/modelContextWindows.ts` 的内置表只有：

```ts
'claude-opus-4-7': 1_000_000
```

没有 `claude-opus-4-8`。

外部用户的模型能力动态查询又不会覆盖所有官方 OAuth 场景，因此 4.8 很可能回退到：

```ts
MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
```

Anthropic 官方实际为 Opus 4.8 提供原生 1M 上下文。这里的错误主要影响客户端本地决策：

- `/context` 百分比错误
- 过早触发自动压缩
- 长会话无法充分利用服务端 1M 上下文
- UI 展示和内核实际决策不一致

值得注意的是，官方 Claude Code `2.1.154` 的变更记录中专门修复过类似问题：旧版本曾把 Opus 4.7 按 200K 计算，导致上下文百分比膨胀和过早压缩。

### 6.5 最大输出错误限制到 32K

`getModelMaxOutputTokens()` 先把 4.8 canonical 成 `claude-opus-4`，随后命中旧 Opus 4 分支：

```ts
defaultTokens = 32_000
upperLimit = 32_000
```

Anthropic 官方给 Opus 4.8 的同步 Messages API 最大输出是 128K。

所以只改模型 ID 后，即使服务端支持 128K，客户端仍可能只申请或允许 32K。

### 6.6 显示名称、定价和能力表缺失

下列结构没有正式的 4.8 条目：

- `ALL_MODEL_CONFIGS`
- `CANONICAL_ID_TO_KEY`
- `getPublicModelDisplayName()`
- `MODEL_COSTS`
- `isNonCustomOpusModel()`
- `modelSupportsStructuredOutputs()` 等模型能力函数

后果包括：

- 部分位置将 4.8 显示为自定义模型
- 成本可能使用未知模型默认值
- 部分 Beta 和能力开关不会按 4.8 正确启用
- Alias `opus` 仍可能解析回旧默认模型

### 6.7 Thinking block 和会话恢复风险

Thinking block 带有服务端签名，而且签名和生成它的模型相关。

高风险操作包括：

- 在已有 4.7 会话中直接切换到 4.8
- 从国产模型或第三方模型切换到官方 Claude
- 在 Fable/Opus 间复用历史 thinking block
- 修改、过滤或重新序列化签名块

官方 Claude Code 在 `2.1.156` 专门修复过：Opus 4.8 thinking block 被修改后导致 API 错误的问题。

cc-haha 上游 Issue `#982` 也已经出现：

```text
Invalid `signature` in `thinking` block
```

因此，对 4.8 的第一轮验证必须使用全新会话，而不是恢复旧会话。

### 6.8 客户端版本仍停留在 2.1.92

`src/constants/claudeCodeCompatibility.ts` 当前包含：

```ts
export const CLAUDE_CODE_COMPAT_VERSION = '2.1.92'
```

该版本会进入 User-Agent、billing attribution 或相关兼容标识。

官方版本要求和时间线是：

| 功能 | 官方 Claude Code 版本 |
| --- | --- |
| Opus 4.8 正式支持 | `2.1.154` |
| Opus 4.8 thinking block 修复 | `2.1.156` |
| Fable 5 支持 | `2.1.170` |

只把 `2.1.92` 改成 `2.1.154`、`2.1.156` 或 `2.1.170` 不是完整解决方案。

这种改法最多可能绕过某些第三方中转站的版本字符串校验，但它不会补上对应版本的真实代码行为，反而会让服务端误以为客户端已经支持新的请求和响应协议。

## 7. 官方订阅与服务端授权

### 7.1 Opus 4.8

Anthropic 当前公开信息表明：

- 模型 ID：`claude-opus-4-8`
- 上下文窗口：1M
- 最大输出：128K
- 支持 adaptive thinking
- 默认 effort：`high`
- 对 Pro、Max、Team 和 Enterprise 用户开放

但最终能否使用仍取决于：

- 账号计划
- 当前额度和 usage credits
- 组织策略
- 区域和服务端可用性
- OAuth 是否属于正确账号/组织

因此，cc-haha 能发送模型 ID，不等于它能越过 Anthropic 的账号授权。

### 7.2 Fable 5

Anthropic 当前公开信息表明：

- 模型 ID：`claude-fable-5`
- 上下文窗口：1M
- 最大输出：128K
- adaptive thinking 始终开启
- 不支持手工 `budget_tokens` thinking
- 安全分类器可能拒绝请求或回退到 Opus 4.8
- 部分部署/组织还受数据保留策略限制

截至 2026-07-20，Anthropic 在恢复 Fable 5 全球访问时说明：Pro、Max、Team 和部分 Enterprise 用户在 2026-07-07 后通常需要 usage credits。

这意味着 Fable 5 的问题不仅是模型 ID 和客户端版本，也包含当前账号的计费与资格策略。

## 8. 为什么上游 `#1024` 不是官方 OAuth 模型问题的完整修复

上游曾合并与 `#1024` 相关的修复：

- `b7f1dd6d`：`fix(server): include configured role models (#1024)`
- `d500497b`：`fix(server): honor configured current model (#1024)`

该问题主要针对 cc-switch 本地路由和配置模型枚举，解决的是：

- 模型列表未包含配置的 role models
- 当前配置模型没有被服务端正确尊重

它并没有完成以下工作：

- 把官方默认模型从 Opus 4.7 升级到 4.8
- 给内核加入 Opus 4.8/Fable 5 的模型注册
- 修复 adaptive thinking、effort、1M 上下文和 128K 输出
- 升级泄露内核到官方 Claude Code 2.1.154+
- 修复官方 OAuth 下的新模型协议兼容

而且标准 `SettingsService` 对 `~/.claude/settings.json` 的处理，不等价于 cc-haha 的 `~/.claude/cc-haha/settings.json` 管理路径。

所以不能把 `#1024` 当成“官方订阅只能使用 Opus 4.7”问题已经修复的证据。

## 9. 网上已有方案和社区现状

### 9.1 cc-haha Issue #679

用户使用第三方接口调用 Opus 4.8 时遇到“Claude 版本过低”。维护者回复的核心内容是：

> 项目基于当时泄露的源代码，无法直接升级到官方 CLI 版本；第三方中转站的版本拦截无法在现有结构中直接处理。

这个 Issue 证明第三方 Provider 可能校验客户端版本，但它不能直接证明官方 Anthropic OAuth 一定拒绝完整模型 ID。

### 9.2 cc-haha Issue #899

该 Issue 中已经有人配置：

```json
{
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
  "ANTHROPIC_DEFAULT_FABLE_MODEL": "..."
}
```

但问题仍处于开放状态，没有形成官方 OAuth 下的完整兼容补丁。

### 9.3 cc-haha Issue #982

Fable 5 第三方模型已经出现 thinking signature 400 错误，而且没有对应修复 PR。

### 9.4 PR 和 Fork 检查结论

在分析时检查到的上游 PR 和活跃 Fork 中，没有发现同时满足以下条件的公开方案：

1. 正式注册 Opus 4.8/Fable 5。
2. 修复 thinking、effort、上下文和输出限制。
3. 使用官方 OAuth 完成真实模型响应验证。
4. 覆盖工具调用、恢复会话和模型切换测试。
5. 已经合并到上游主分支。

网上有一些所谓的 “Fable mode”，本质是给 Opus 4.8 添加提示词来模仿行为，并不是真正调用 `claude-fable-5`。

## 10. OpenCode 旧版 Claude 订阅方案分析

### 10.1 先说结论

用户记忆中的情况属实：OpenCode 旧版本曾经允许用户通过 Claude Pro/Max OAuth 登录，并用订阅额度直接调用 Anthropic 模型。

但是，这个方案需要分成两个完全不同的部分看待：

1. OAuth 和请求伪装层：复用 Claude Code 的 OAuth 流程，让 OpenCode 自己直接调用 Anthropic Messages API。
2. 模型与能力层：通过动态模型目录和 Provider transform 识别新模型的上下文、输出、thinking 和 effort。

第一部分已经被 OpenCode 官方移除，不能视为长期、合规的参考实现；第二部分非常值得 cc-haha 借鉴。

当前 OpenCode 官方文档明确说明：

- 旧版本曾内置 Claude Pro/Max OAuth 插件。
- 从 OpenCode `1.3.0` 起不再内置。
- 文档给出的原因是 Anthropic 明确禁止第三方这样使用 Claude Pro/Max 订阅。

OpenCode `1.3.0` 发布于 2026-03-22，发布说明第一项就是移除 Anthropic OAuth 插件。

### 10.2 OpenCode 旧版是如何使用 Claude 订阅的

OpenCode 最早把 Anthropic OAuth 实现在自己的源码中，后来将其拆成 npm 插件：

```text
opencode-anthropic-auth@0.0.13
```

OpenCode `1.2.27` 会默认加载这个插件：

```ts
const BUILTIN = ['opencode-anthropic-auth@0.0.13']
```

这个插件没有启动官方 Claude CLI，而是自己完成下面的流程。

#### 10.2.1 复用 Claude Code OAuth 客户端

插件复用了 Claude Code 使用的 OAuth client ID，并通过 PKCE 打开：

```text
https://claude.ai/oauth/authorize
```

请求的 scope 包含：

```text
org:create_api_key
user:profile
user:inference
```

用户在浏览器授权后，插件将授权码发送到：

```text
https://console.anthropic.com/v1/oauth/token
```

换取：

- access token
- refresh token
- expires timestamp

Access token 到期后，OpenCode 自己使用 refresh token 刷新，而不是委托官方 Claude Code 管理。

#### 10.2.2 直接调用 Anthropic Messages API

OpenCode 使用 `@ai-sdk/anthropic` 生成标准 Anthropic 请求，然后插件通过自定义 `fetch()` 修改请求：

```text
authorization: Bearer <OAuth access token>
anthropic-beta: oauth-2025-04-20,...
```

同时删除：

```text
x-api-key
```

也就是说，它不是把 Claude Code 当成子进程，而是把 Claude Code OAuth token 当成 Anthropic API 的 Bearer token 直接使用。

#### 10.2.3 模拟 Claude Code 请求特征

为了让订阅 OAuth 请求被服务端接受，旧插件还做了以下处理：

- 将 User-Agent 设置成 `claude-cli/...`。
- 在 system prompt 中声明自己是 Claude Code。
- 清理 system prompt 里的 `OpenCode` 字样。
- 给工具名添加 `mcp_` 前缀。
- 在流式响应中再把 `mcp_` 前缀移除。
- 合并 Claude Code/OAuth 所需 Beta header。
- 对 `/v1/messages` 请求追加 Beta 路由参数。

因此，它并不是一种正式公开的“第三方应用使用 Claude 订阅”接口，而是一套对 Claude Code 客户端行为的复刻。

### 10.3 为什么 OpenCode 能较快出现最新模型

OpenCode 能快速看到新模型，并不只是因为 OAuth。

它的模型架构和 cc-haha 有一个重要区别：OpenCode 把模型元数据集中到了动态目录，而不是把模型版本散落硬编码在多个业务函数中。

当前 OpenCode 使用：

```text
https://models.dev/api.json
```

模型目录包含：

- model ID
- 显示名称和 family
- 发布时间
- 是否支持 reasoning/tool call/附件/结构化输出
- 上下文窗口
- 最大输出
- effort 选项
- 输入输出模态
- 定价和缓存价格
- 实验模式和所需 Header

OpenCode 对模型目录的处理还包括：

- 本地缓存
- 5 分钟新鲜度判断
- 每 60 分钟后台刷新
- 网络不可用时使用内置 snapshot
- 允许配置自定义目录 URL 或本地目录文件

截至分析时，`models.dev` 已经提供：

| 模型 | Context | Max output | Reasoning |
| --- | ---: | ---: | --- |
| `claude-opus-4-8` | 1,000,000 | 128,000 | 是 |
| `claude-fable-5` | 1,000,000 | 128,000 | 是 |
| `claude-sonnet-5` | 1,000,000 | 128,000 | 是 |

所以 OpenCode 的模型下拉列表可以通过数据更新获得新模型，不需要每次修改 UI 常量。

不过，动态目录仍不能解决所有协议差异。OpenCode 后来仍然为新模型补过代码：

- `#29769`：支持 Opus 4.7 及以后版本的 adaptive reasoning。
- `#31546`：支持 Claude Fable reasoning。
- `#30027`：对新的 adaptive thinking 模型默认请求 summarized thinking。

这说明正确架构应当是：

```text
动态模型元数据
  +
少量集中、可前向兼容的协议转换规则
```

而不是认为只要模型目录更新，所有新协议都会自动兼容。

### 10.4 OpenCode 当前如何判断新 Anthropic 模型能力

当前 OpenCode 已经移除订阅 OAuth 插件，但它在 API key、Gateway、Bedrock、Vertex 等 Provider 下仍需要支持最新 Claude 模型。

它使用前向兼容的 family/version 规则，例如：

```text
Opus 4.7 及以上
Sonnet 5 及以上
Fable 5
```

这些模型统一映射到：

```json
{
  "thinking": {
    "type": "adaptive",
    "display": "summarized"
  },
  "effort": "high"
}
```

可选 effort 包括：

```text
low, medium, high, xhigh, max
```

相比之下，cc-haha 目前在多个文件中通过 `includes('opus-4-6')`、`includes('opus-4-7')` 等具体字符串判断能力。这种写法会让每个新模型都需要全仓库补丁，而且很容易出现“请求 ID 已经是新模型，但能力仍按旧模型处理”的半兼容状态。

### 10.5 OpenCode 为什么移除了这套 OAuth 方案

2026-03-19，OpenCode 合并 PR `#18186`，标题为 `anthropic legal requests`。该 PR 删除了：

- 默认安装的 `opencode-anthropic-auth` 插件
- Claude Code 专用 Beta header
- Claude Code system prompt 副本
- Provider 页面中的 Claude Pro/Max 官方入口

随后 OpenCode `1.3.0` 正式发布这项移除。

此外，npm 上的 `opencode-anthropic-auth@0.0.13` 当前已经标记为 deprecated。

Anthropic 当前官方帮助文档也明确区分：

- 第三方工具首选 API key 或受支持的云 Provider。
- Anthropic 可能自行决定让启用 usage credits 的订阅用户在某些第三方工具中使用 Claude。
- 冒充客户端身份、把第三方流量伪装成原生 Claude Code 流量，或绕过订阅限制的行为被禁止，并可能受到执行措施。

OpenCode Issue `#6930` 中还有用户报告账号在通过 OpenCode OAuth 使用订阅后被封。单个用户报告不能证明所有账号都会被封，但足以说明这不是一个可以忽略的理论风险。

因此，不建议把旧 OpenCode 插件的以下行为移植到 cc-haha：

- 复制 Claude Code OAuth client ID 作为第三方客户端登录入口。
- 伪装 Claude Code User-Agent。
- 将 OpenCode/cc-haha system prompt 改写成“官方 Claude Code”。
- 通过 Header、工具名前缀和请求改写绕过服务端客户端识别。
- 直接读取或搬运官方 Claude Code 的 OAuth 凭据到另一个程序。

### 10.6 哪些部分值得 cc-haha 参考

| OpenCode 设计 | 是否建议参考 | 原因 |
| --- | --- | --- |
| 动态模型目录 | 建议 | 消除桌面和内核的重复硬编码 |
| 集中的模型能力 Schema | 建议 | 可统一 context、output、effort、thinking、price |
| Provider transport adapter | 建议 | 官方、第三方、Bedrock、Vertex 可以有不同协议 |
| 前向兼容的 family/version 规则 | 建议 | 避免每个新模型散改多个文件 |
| Thinking block 作为 opaque 数据保留 | 建议 | 避免 signature 被修改 |
| 请求/响应模型 ID Trace | 建议 | 能证明实际模型和回退行为 |
| 直接复用 Claude Code OAuth client ID | 不建议 | 当前官方政策明确反对客户端冒充 |
| 伪装 User-Agent/system prompt | 不建议 | 有账号和合规风险 |
| 只靠模型目录推断所有协议 | 不建议 | Fable 等模型仍需要显式协议适配 |

### 10.7 cc-haha 可以采用的动态模型架构

cc-haha 已经有 `src/utils/model/modelCapabilities.ts`，并且已经能调用 Anthropic Models API，但目前对外部用户的启用条件过于严格。

推荐的数据优先级是：

1. 官方 Anthropic Models API 返回的当前账号可用模型和能力。
2. 仓库内维护的官方模型 snapshot。
3. 可选的 `models.dev` 数据源，用于第三方 Provider 元数据补充。
4. 用户在 `~/.claude/cc-haha/settings.json` 中的显式 model/context override。

推荐建立统一的 `ModelCapability` 结构：

```ts
interface ModelCapability {
  id: string
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'
  contextWindow: number
  maxOutputTokens: number
  supportsAdaptiveThinking: boolean
  requiresAdaptiveThinking: boolean
  supportedEffortLevels: string[]
  supportsStructuredOutput: boolean
  supportsTools: boolean
  pricing?: ModelPricing
}
```

然后让下面所有模块读取同一份 capability，而不是分别判断字符串：

- Desktop 模型下拉框
- `getContextWindowForModel()`
- `getModelMaxOutputTokens()`
- `modelSupportsEffort()`
- `modelSupportsAdaptiveThinking()`
- Beta header 选择
- 成本估算
- 模型切换历史清理

### 10.8 最值得采用的订阅适配方式：官方 Agent SDK

如果目标是“cc-haha 使用 Claude 官方订阅，同时持续获得最新模型”，更合理的参考对象不是旧 OpenCode OAuth 插件，而是官方 Claude Agent SDK。

Anthropic 当前官方说明中提到：截至 2026-06-15，原定的 Agent SDK 计费调整已暂停，现阶段 Claude Agent SDK、`claude -p` 和通过 Agent SDK 构建的第三方应用仍会使用订阅额度。该政策未来可能变化，但至少这是当前公开支持的路径，不需要伪装客户端身份。

Agent SDK/官方 CLI 已经提供 cc-haha 所需的大部分能力：

- `stream-json` 消息流
- 指定完整 model ID 或 alias
- session ID 和 resume
- partial messages
- 工具权限回调
- hooks
- MCP
- 中断和关闭会话
- 模型能力信息
- 官方 OAuth 和 token 刷新
- 随 Claude Code 更新获得新模型协议

建议给 cc-haha 增加并行的 runtime adapter：

```text
ConversationRuntime
  |- LegacyEmbeddedRuntime       当前泄露内核和第三方 Provider
  |- OfficialAgentSdkRuntime     官方订阅和官方最新模型
  `- DirectApiRuntime            API key/自定义 Anthropic 兼容接口
```

在官方模式下：

1. cc-haha 不再读取并重放 OAuth token。
2. 由官方 Claude CLI/Agent SDK 完成登录、刷新和请求签名。
3. cc-haha Server 把桌面消息转换成 SDK query/input stream。
4. SDK stream 事件再转换成现有 WebSocket 消息。
5. 工具确认通过 SDK `canUseTool`、PermissionRequest hook 或 permission prompt 接回桌面。
6. 会话恢复使用官方 session ID，并在 cc-haha 中维护映射。

这条路线仍然需要开发，不是简单替换一个路径。当前 cc-haha 使用的：

```text
--sdk-url
--enable-auth-status
```

是旧内核私有参数。Agent SDK adapter 必须绕过现有 `buildSessionCliArgs()`，不能继续把这些参数传给官方 CLI。

### 10.9 Agent SDK 适配的工程难点

需要重点验证：

1. 现有 cc-haha WebSocket 事件与 SDK message 类型的完整映射。
2. Desktop 权限弹窗与 SDK permission callback 的双向等待。
3. 中断、排队输入和后台任务状态。
4. cc-haha session ID 与官方 Claude session ID 的持久化映射。
5. Resume 后 thinking/tool block 是否保持原样。
6. CLI 自动更新与 Agent SDK bundled CLI 版本谁优先。
7. 打包后的 Tauri sidecar 是否能发现本机官方 CLI。
8. 第三方 Provider 继续走旧 runtime，不能被官方模式改动破坏。
9. `~/.claude/cc-haha/` 与官方 `~/.claude/` 状态保持隔离，不能复制 OAuth 文件。
10. Anthropic 后续对 Agent SDK 订阅计费政策变化时的降级策略。

### 10.10 对当前项目的建议判断

从纯技术角度看，旧 OpenCode 证明了两件事：

1. 不依赖泄露 Claude Code 内核，也能自己实现工具循环并调用最新 Claude 模型。
2. 动态模型元数据可以显著降低跟进新模型的成本。

但它也证明了另一件更重要的事：

> 直接复制 Claude Code OAuth 和伪装官方客户端不是稳定产品架构，服务端策略或法律要求随时可以让它失效。

所以 cc-haha 最合理的参考方式是：

- 学 OpenCode 的动态模型目录、能力 Schema 和 Provider adapter。
- 不学旧 OpenCode 的 OAuth 冒充层。
- 官方订阅模式迁移到官方 Claude Agent SDK/官方 CLI。
- API key 和第三方 Provider 继续使用 cc-haha 自己的 transport。

## 11. 可落地解决路线

### 11.1 路线 A：最小 Opus 4.8 实验补丁

目标：只验证官方 OAuth 是否接受旧内核发出的 4.8 请求。

最小变更：

1. 将 `OFFICIAL_DEFAULT_MODEL_ID` 改为 `claude-opus-4-8`。
2. 将 `OFFICIAL_MODELS` 的 Opus 条目改为 4.8。
3. 使用全新会话。
4. 使用官方 OAuth，确保没有自定义 Provider 覆盖。
5. 从 Trace 中检查请求和响应模型 ID。

优点：

- 改动小
- 能快速回答服务端是否接受
- 如果响应模型为 4.8，可以确认实际模型路由成功

缺点：

- thinking 和 effort 不完整
- 上下文和输出限制错误
- 恢复会话风险高
- 不能据此宣称正式支持

### 11.2 路线 B：完整 Opus 4.8 兼容补丁

至少需要覆盖：

1. `desktop/src/constants/modelCatalog.ts`
   - 增加 4.8 模型和正确描述。
2. `src/utils/model/configs.ts`
   - 新增独立 Opus 4.8 配置和 ModelKey。
3. `src/utils/model/model.ts`
   - Canonical 映射。
   - 默认 Opus Alias。
   - 显示名称。
   - `isNonCustomOpusModel()`。
4. `src/utils/effort.ts`
   - effort 支持。
   - `xhigh`/`max` 的真实能力矩阵。
5. `src/utils/thinking.ts`
   - adaptive thinking。
   - 禁止旧 budget thinking。
6. `src/utils/model/modelContextWindows.ts`
   - 原生 1M 上下文。
7. `src/utils/context.ts`
   - 128K 最大输出。
8. `src/utils/betas.ts`
   - 按官方能力更新 Beta 和结构化输出判定。
9. `src/utils/modelCost.ts`
   - 正确定价和 fast mode 价格。
10. Query/Transcript 处理
   - 模型切换时正确处理旧 thinking block。
   - 不修改签名内容。
11. 测试
   - 模型解析测试。
   - 请求体测试。
   - thinking/effort 测试。
   - 1M/128K 测试。
   - 新会话、恢复会话和模型切换测试。
   - 官方 OAuth live smoke。

不建议在没有行为对齐的情况下单独伪造更高的 Claude Code 版本号。

### 11.3 路线 C：Fable 5 单独适配

Fable 5 需要独立设计，不能只复制 Opus 4.8：

1. 注册 `claude-fable-5`。
2. 将 adaptive thinking 视为始终开启。
3. 不能发送 `thinking: { type: "disabled" }`。
4. 不能发送旧式 `budget_tokens` thinking。
5. 正确保留同模型会话的 thinking signature。
6. 跨模型切换时剥离不兼容的 thinking/redacted thinking block。
7. 处理 `stop_reason: "refusal"` 和 `stop_details`。
8. 识别安全分类器触发后的 Opus 4.8 回退。
9. 正确处理 1M 上下文、128K 输出和 Fable 定价。
10. 明确订阅账号是否具备 usage credits 和数据保留资格。

### 11.4 路线 D：长期改为官方 CLI 内核

本机已经安装官方 Claude Code `2.1.215`，理论上原生支持 Opus 4.8 和 Fable 5。

但 cc-haha 不能简单将 `CLAUDE_CLI_PATH` 指向官方二进制，因为它启动内核时还传递私有参数：

```text
--sdk-url
--enable-auth-status
```

官方 Claude Code 不接受这些参数，直接替换会报 `bad option: --sdk-url`。

长期方案应当是：

1. 将 cc-haha 的 WebSocket 私有控制通道抽象成适配器。
2. 改用官方 CLI 支持的 `--print`、`stream-json` 输入输出协议。
3. 在 cc-haha Server 中管理会话、权限、Provider 和状态映射。
4. 不再依赖泄露内核中的私有启动参数。

这是工作量最大的方案，但也是未来持续跟随 Anthropic 新模型最可靠的架构。

### 11.5 路线 E：官方 Agent SDK Runtime（优先推荐）

与路线 D 直接手写 CLI stream-json bridge 相比，优先评估官方 TypeScript Agent SDK：

1. 在 Server 层增加 `OfficialAgentSdkRuntime`，不改 Desktop 协议。
2. 先只覆盖官方 Anthropic Provider，新旧 runtime 并存。
3. 使用本机官方 Claude Code 或 Agent SDK 自带的兼容 CLI。
4. 把现有 `RuntimeSettings.model` 原样传给 SDK。
5. 把 SDK partial/result/tool/permission 事件转换为现有 WS 事件。
6. 用全新会话完成 Opus 4.8 live smoke。
7. 再验证 Fable 5、resume、工具权限和模型切换。

该路线的主要优势是 OAuth、客户端版本、thinking 协议和新模型支持都由 Anthropic 官方组件维护。代价是需要增加 runtime 抽象，并重新实现当前 `--sdk-url` 控制通道承担的功能。

## 12. 推荐验证流程

### 12.1 前置条件

1. 备份 `~/.claude/cc-haha/`。
2. 切换到官方 Anthropic Provider。
3. 确认使用官方 OAuth，而不是 `ANTHROPIC_API_KEY` 或第三方 Base URL。
4. 不恢复旧会话，创建全新 session ID。
5. 初次测试只发送一个简短问题，避免消耗大量订阅额度。

### 12.2 必须检查的证据

请求侧：

```json
{
  "model": "claude-opus-4-8"
}
```

响应侧：

```json
{
  "type": "message_start",
  "message": {
    "model": "claude-opus-4-8"
  }
}
```

判定标准：

| 结果 | 结论 |
| --- | --- |
| 请求和响应都是 `claude-opus-4-8` | 实际调用到 Opus 4.8 |
| 请求是 4.8，响应是其他模型 | 服务端发生回退或代理改写 |
| 请求是 4.7 | 客户端配置/运行时覆盖没有生效 |
| 返回版本过低 | 客户端版本门槛或中转站校验 |
| 返回模型不可用/无权限 | 账号计划、额度或组织策略限制 |
| 返回 thinking signature 400 | 历史会话或签名处理不兼容 |

### 12.3 功能测试矩阵

模型路由通过后，还应验证：

1. 普通文本新会话。
2. adaptive thinking。
3. `high` 和 `xhigh` effort。
4. Bash/Edit/Read 等工具调用。
5. 连续多轮对话。
6. 停止并恢复同一个 4.8 会话。
7. 4.7 切换到 4.8。
8. 第三方模型切换到官方 4.8。
9. 长上下文下的自动压缩阈值。
10. 大输出上限。

只有这些路径通过，才能将状态从“实验性可调用”提升为“完整兼容”。

## 13. 最终判断

### 对 Opus 4.8

直接改模型 ID 的技术效果是明确的：

```text
桌面选择 4.8
  -> runtime modelId = claude-opus-4-8
  -> --model claude-opus-4-8
  -> Messages API model = claude-opus-4-8
```

如果官方服务接受并返回同一个模型 ID，实际就是 Opus 4.8。

但是当前旧内核没有完整的 4.8 能力矩阵，不能仅凭一次普通文本回复就认为兼容工作已经完成。

### 对 Fable 5

Fable 5 不是永远无法使用，但不能通过单点字符串替换可靠实现。它需要客户端协议适配、会话历史处理、账号资格和 usage credits 同时满足。

### 推荐优先级

1. 不移植旧 OpenCode 的 OAuth client ID、User-Agent 和 system prompt 伪装逻辑。
2. 先将模型元数据和能力判断集中成统一 Schema，消除散落硬编码。
3. 建立 `OfficialAgentSdkRuntime` 原型，用官方订阅完成 Opus 4.8 新会话验证。
4. 保留现有泄露内核作为第三方 Provider 兼容 runtime，避免一次性重写。
5. Agent SDK 路线验证失败时，再退回直接 CLI stream-json bridge。
6. 将 Fable 5 作为独立协议适配和 live smoke 项目。
7. 最小直接 OAuth 补丁只用于诊断，不作为长期发布方案。

## 14. 参考资料

### Anthropic 官方

- [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Model migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Claude Code model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Introducing Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8)
- [Claude Opus 4.8 availability](https://www.anthropic.com/claude/opus)
- [Claude Fable 5](https://www.anthropic.com/claude/fable)
- [Redeploying Fable 5](https://www.anthropic.com/news/redeploying-fable-5)
- [Use Claude Code with a Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Anthropic 对订阅 OAuth 与第三方工具的说明](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

### cc-haha 上游

- [Issue #679: 第三方 Opus 4.8 提示客户端版本过低](https://github.com/NanmiCoder/cc-haha/issues/679)
- [维护者关于泄露内核无法直接升级的回复](https://github.com/NanmiCoder/cc-haha/issues/679#issuecomment-4590920989)
- [Issue #899: 配置 Opus 4.8/Fable model 后的 Provider 问题](https://github.com/NanmiCoder/cc-haha/issues/899)
- [Issue #982: Fable thinking signature 错误](https://github.com/NanmiCoder/cc-haha/issues/982)
- [Issue #1024: cc-switch 本地路由模型选择问题](https://github.com/NanmiCoder/cc-haha/issues/1024)

### OpenCode

- [OpenCode Provider 文档中的 Anthropic 现状说明](https://opencode.ai/docs/providers#anthropic)
- [OpenCode v1.3.0 Release](https://github.com/anomalyco/opencode/releases/tag/v1.3.0)
- [PR #18186: anthropic legal requests](https://github.com/anomalyco/opencode/pull/18186)
- [Issue #1461: OpenCode 如何获得 Anthropic OAuth credentials](https://github.com/anomalyco/opencode/issues/1461)
- [Issue #6930: 用户报告通过 OpenCode OAuth 使用订阅后被封](https://github.com/anomalyco/opencode/issues/6930)
- [OpenCode ModelsDev 实现](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/models-dev.ts)
- [OpenCode Provider model transform](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts)
- [models.dev Anthropic 模型目录](https://models.dev/api.json)
- [PR #29769: Opus 4.7+ adaptive reasoning](https://github.com/anomalyco/opencode/pull/29769)
- [PR #31546: Claude Fable reasoning](https://github.com/anomalyco/opencode/pull/31546)
