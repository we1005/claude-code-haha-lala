# cc-haha 从 Opus 4.6 到 4.7 的适配补丁，以及迁移到 Opus 4.8 / Opus 5 的可行性

> 调研日期：2026-07-26
> 本地代码版本：`a159ee35`
> 调研时远端 `origin/main`：`47d47d18`
> 变更面：`provider/runtime`、`agent-loop`、`docs`

## 一、先给出结论

1. **是的，这份仓库最初导入的泄露源码以 Opus 4.6 为默认 Opus。** 初始提交 `f5a40b86` 中，配置、默认模型、提示词环境元数据和大量模型能力判断都指向 `claude-opus-4-6`。
2. **`20806f40` 的 4.7 补丁不只是改下拉列表。** 它把第一方、Bedrock、Vertex、Foundry 等配置中的实际模型 ID 改成了 4.7；经 `--model opus` 解析后，最终 API 请求的 `model` 字段会变成 `claude-opus-4-7`。只要服务端接受这个 ID，并且登录账号有相应权限，远端实际执行的就可以是 Opus 4.7。
3. **但这个补丁没有“获得”或“解锁”模型。** 模型权重始终在 Anthropic 或云厂商服务端。补丁做的是让旧客户端请求新模型，并补少量本地识别逻辑；账号 entitlement、组织策略、配额、计费通道和服务端兼容性都不是改源码能授予的。
4. **这个 4.7 补丁明显不是官方 Claude Code 2.1.111 的完整移植。** 它主要是模型 ID、显示名、提示词环境元数据、部分 allowlist 和测试夹具的等量替换。努力等级、自适应思考、1M 上下文、Fast mode、Advisor 等多处逻辑仍只识别 `opus-4-6`。
5. **对 Opus 4.8，“相同思路”在基本 Messages API 层面有较高可行性，但仍有条件。** Anthropic 官方称从 4.7 迁移到 4.8 没有 API breaking change，因此对于本来就正确工作的 4.7 基础请求，更换模型 ID 可能足以获得一个基础 4.8 回复。不过 Claude Code 2.1.154 还同时带来了 4.8 的 effort、thinking、Fast mode、lean system prompt、上下文和错误修复；仅改 ID 并不等于完整支持这些能力。
6. **远端 cc-haha 已经在 2026-07-22 加入了一个比 4.7 补丁更完整的 4.8/Fable 5/Sonnet 5 适配。** 提交为 `29b17c80`。本地分支尚未包含它；本次只读取和比较了远端引用，没有合并或覆盖本地改动。
7. **对 Opus 5，单改 ID 最多只能用于探测，不能称为支持。** 当前本地和当前远端都没有正式的 Opus 5 配置。Opus 5 相对 4.8/4.7 存在 thinking 默认行为等 breaking changes，官方 Claude Code 最低版本也提高到 2.1.219。旧运行时即使偶尔得到一轮文本响应，也可能在 effort、thinking round-trip、工具调用、多轮续写、缓存、Fast mode、回退或计费上失败。
8. **使用同一个 Claude Team 订阅登录，不保证第三方重组客户端能持续使用最新模型。** OAuth 只证明账号身份；服务端仍会根据 seat、organization、rollout、quota、客户端契约和请求形状决定是否开放模型。官方文档还把订阅 OAuth 的普通用途限定在 Claude Code 和 Anthropic 原生应用；把 Claude.ai 登录嵌入或转接给第三方客户端存在明确的支持与合规风险。
9. **稳定方案不是继续追着官方私有请求格式打补丁，而是让 cc-haha 调用官方最新版 Claude Code 或 Claude Agent SDK。** 这样认证、模型选择、请求协议、thinking、工具 round-trip 和版本升级由官方执行引擎负责，cc-haha 只承担 UI、编排和本地产品能力。公开分发或服务端产品则应使用 Anthropic API key、Bedrock、Vertex AI 或 Foundry。

一句话概括：

> 4.7 补丁证明了“旧客户端可以通过改路由请求一个服务端已经开放的新模型”，但没有证明“改几个字符串就得到了新版本 Claude Code”。越往 Opus 5 走，这两者的差距越大。

## 二、需要纠正的版本现状

此前“上游最新版本仍然只把官方默认模型硬编码为 4.7”的结论，**只适用于当前本地检出的 `a159ee35`，不再适用于 2026-07-26 的远端 `origin/main`**。

| 范围 | 当前事实 |
| --- | --- |
| 本地 `HEAD`：`a159ee35` | 默认 Opus 是 4.7；没有 4.8、Fable 5、Sonnet 5、Opus 5 的完整配置 |
| 远端提交 `29b17c80` | 加入 Opus 4.8、Fable 5、Sonnet 5 的模型配置、能力判断、UI 和测试 |
| 远端 `origin/main`：`47d47d18` | 包含 `29b17c80`；仍未发现正式 Opus 5 配置 |
| 官方 Claude Code | 当前文档中 `opus` 指向 Opus 5；不同模型有明确最低 Claude Code 版本 |

远端 4.8 补丁并未自动进入本地工作树。本次执行过 `git fetch origin --prune` 以读取最新远端提交，但没有 merge、rebase、checkout，也没有修改已有运行时代码。

## 三、源码最初是不是 Opus 4.6

答案是肯定的。

### 3.1 初始导入

仓库初始提交：

```text
f5a40b86  2026-03-31  init: add source code from src.zip
```

初始版本的模型配置包含：

```ts
export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
}
```

它还把：

- `Claude Opus 4.6` 作为前沿模型显示名；
- `claude-opus-4-6` 作为默认 Opus ID；
- `opus46` 作为内部模型配置键；
- 多个 effort、thinking、context、Fast mode 和 Advisor 分支绑定到 `opus-4-6`。

初始源码里虽然出现过 `opus-4-7` 字样，但只是在 `undercover.ts` 的示例中，把它当成“尚未发布的模型版本号”示例，不是可运行的模型配置。

因此更准确的历史描述是：

> cc-haha 的泄露源码基线是一个以 Opus 4.6 为最高 Opus 的 Claude Code 运行时快照，随后维护者在这个快照上进行了本地模型升级适配。

## 四、4.7 “适配补丁”究竟改了什么

### 4.1 提交时间线

| 提交 | 日期 | 作用 |
| --- | --- | --- |
| `f5a40b86` | 2026-03-31 | 导入以 Opus 4.6 为默认值的源码 |
| `c444e439` | 2026-04-18 | 先把 Desktop 的官方默认模型和 mock 显示改成 4.7，共两处 |
| `20806f40` | 2026-04-18 | 45 个文件中进行 116 行增加、116 行删除的 4.6→4.7 替换 |
| `df60c774` | 2026-05-19 | 另行加入旧 Claude Code 兼容标识/归因逻辑，不属于 4.7 模型补丁 |
| `29b17c80` | 2026-07-22 | 远端加入 Opus 4.8、Fable 5、Sonnet 5 的较大范围适配 |

`20806f40` 的 `+116/-116` 很有说明性：它基本是等量替换，而不是把一个完整的新版本 Claude Code 功能模块移植进来。

### 4.2 它确实改变了最终 API 的模型

本地模型请求主链路是：

```text
--model opus
  → parseUserSpecifiedModel()
  → getDefaultOpusModel()
  → getModelStrings().opus46
  → ALL_MODEL_CONFIGS.opus46
  → CLAUDE_OPUS_4_6_CONFIG.firstParty
  → claude-opus-4-7
  → API request body.model
```

相关代码：

- [`src/utils/model/configs.ts`](./src/utils/model/configs.ts#L81)：变量名仍为 `CLAUDE_OPUS_4_6_CONFIG`，但值已经是 4.7。
- [`src/utils/model/model.ts`](./src/utils/model/model.ts#L110)：解析默认 Opus。
- [`src/utils/model/model.ts`](./src/utils/model/model.ts#L477)：解析用户指定的模型。
- [`src/utils/model/model.ts`](./src/utils/model/model.ts#L652)：API 前的模型字符串规范化。
- [`src/services/api/claude.ts`](./src/services/api/claude.ts#L1765)：把规范化后的值写入请求 `model` 字段。

`normalizeModelStringForAPI()` 并不会把 4.7 偷偷改回 4.6；它主要去掉本地的上下文窗口后缀。因此，在服务端接受请求时，这不是“界面显示 4.7、实际仍发 4.6”，而是确实请求 4.7。

但是这里必须加上三个限定条件：

1. 服务端必须认识并开放这个模型 ID；
2. 当前 OAuth 账号、Team 组织和 seat 必须有该模型权限和额度；
3. 服务端或中间代理必须接受这个旧客户端发出的完整请求形状。

满足这些条件时，远端执行的可以是真正的 Opus 4.7。补丁本身没有在本地安装任何模型权重。

### 4.3 它补到的运行时范围

`20806f40` 不只是 UI 文本替换，还涉及：

- 第一方、Bedrock、Vertex、Foundry、Azure OpenAI 兼容模型 ID；
- 默认模型与部分 canonical model 映射；
- Structured Outputs allowlist；
- 系统提示词中的模型显示名、模型知识截止日期等环境元数据；
- FileReadTool 的部分模型安全提示分支；
- Desktop、Server、CLI 的默认模型和选择项；
- 成本映射的间接引用；
- 测试夹具和 mock 数据。

所以称它为“模型名称补丁”也不完全准确。它至少改变了真实请求路由和少数本地能力开关。

### 4.4 它没有补到的范围

本地 `a159ee35` 中仍存在这些明显的 4.6 专属判断：

| 能力 | 本地现状 | 对精确 `claude-opus-4-7` 的结果 |
| --- | --- | --- |
| Effort 支持 | [`src/utils/effort.ts`](./src/utils/effort.ts#L33) 仍匹配 `opus-4-6` | 未识别为完整支持 |
| Adaptive thinking | [`src/utils/thinking.ts`](./src/utils/thinking.ts#L140) 仍匹配 4.6 | 不启用 4.7 分支 |
| 1M context | [`src/utils/context.ts`](./src/utils/context.ts#L50) 仍匹配 4.6 | 不启用 Opus 1M 分支 |
| 最大输出特殊值 | [`src/utils/context.ts`](./src/utils/context.ts#L221) 仍匹配 4.6 | 落入旧/通用路径 |
| Fast mode | [`src/utils/fastMode.ts`](./src/utils/fastMode.ts#L175) 仍匹配 4.6 | 显示可提到 4.7，实际判定为不支持 |
| Advisor | [`src/utils/advisor.ts`](./src/utils/advisor.ts#L92) 仍匹配 4.6 | 不启用 Opus 特殊路径 |
| Extra usage | [`src/utils/extraUsage.ts`](./src/utils/extraUsage.ts#L17) 仍匹配 4.6 | 不识别精确 4.7 |
| Effort UI callout | [`src/components/EffortCallout.tsx`](./src/components/EffortCallout.tsx#L222) 仍匹配 4.6 | 注释与实现不一致 |
| Structured outputs | [`src/utils/betas.ts`](./src/utils/betas.ts#L154) 已加入 4.7 | 能识别 4.7 |

静态调用这些纯函数时，精确 4.7 ID 的结果也印证了上述缺口：Structured Outputs 能识别，但 effort、adaptive thinking、1M、Advisor 和 Fast mode 等均没有随模型名一起迁移。

官方 Claude Code 2.1.111 的变更记录则包含：

- Opus 4.7 的 `xhigh` effort；
- Max 用户的自动模型行为；
- 模型选择器内的 effort 配置；
- 后续版本对 “4.7 temporarily unavailable” 自动选择问题的修复；
- 后续对 Bedrock Opus 4.7 thinking 参数的修复。

这些都不是 `20806f40` 的等量字符串替换所覆盖的内容。

因此，“适配补丁”的精确定义应当是：

> 一个以模型 ID 重定向为核心，附带 UI/元数据替换和少量 allowlist/运行时分支调整，但保留大量 4.6 行为的兼容补丁。

它能让旧运行时有机会调用 4.7，却不能被视为官方 Claude Code 2.1.111 的完整 4.7 harness。

## 五、为什么“模型可调用”和“完整支持”不是一回事

一个重组客户端要稳定使用新模型，至少要同时跨过五层：

### 5.1 模型路由层

客户端最终是否发送正确的 `model` ID。

4.7 补丁解决了这一层。当前本地的 `parseUserSpecifiedModel()` 对未知的精确模型字符串也会基本原样保留，因此精确的 4.8 或 Opus 5 ID 可以进入请求体。这只能证明旧客户端**能够提出请求**，不能证明请求会成功或行为正确。

### 5.2 账号 entitlement 层

OAuth token 对应的账号、seat 和 organization 是否能使用该模型，以及当时是否已经 rollout。

Anthropic 官方建议以最新版 Claude Code 的 `/model` 为当前账号的实际可用模型来源。网页写着存在某个模型，不等于每个 Team seat 在每个时间点都具备相同访问权和相同额度。

### 5.3 客户端与计费契约层

订阅请求不只是一个 Bearer token。服务端或企业代理还可能校验客户端版本、入口、归因、计费通道和其他请求上下文。

当前本地和远端仍将兼容版本固定为：

```ts
export const CLAUDE_CODE_COMPAT_VERSION = '2.1.92'
```

见 [`src/constants/claudeCodeCompatibility.ts`](./src/constants/claudeCodeCompatibility.ts#L7)。

而官方模型文档列出的 Claude Code 最低版本是：

| 模型 | 官方 Claude Code 最低版本 |
| --- | --- |
| Opus 4.8 | 2.1.154 |
| Fable 5 | 2.1.170 |
| Sonnet 5 | 2.1.197 |
| Opus 5 | 2.1.219 |

这不能直接证明 Anthropic 一定会在所有入口硬拒绝旧版本，但足以证明 `2.1.92 + 新模型 ID` 不属于官方承诺的支持组合。

不应通过伪造版本或复制私有归因算法来绕过校验：这既不等于实现协议兼容，也可能触发服务条款和账号风险。

### 5.4 请求协议层

新模型可能改变：

- thinking 默认状态和合法参数组合；
- effort 等级；
- beta headers；
- context window 和最大输出；
- prompt caching 阈值；
- tool schema 与工具调用 round-trip；
- thinking block 的签名与原样回传要求；
- fallback、overage、Fast mode；
- 多轮续写和 compaction 行为。

一轮纯文本成功只能证明最窄的请求路径可用。

### 5.5 Claude Code harness 层

Claude Code 的完整行为还取决于：

- system prompt 的基础段和动态段；
- 当前注册的工具集及 tool descriptions；
- subagent、skills、memory、scratchpad；
- permissions、hooks、MCP；
- context management、resume、compact；
- 模型专属行为开关和错误恢复。

这正是“调用到了 4.7/4.8/5 模型”和“拥有对应版本 Claude Code 能力”之间的差别。

## 六、能否用同样方法迁移到 Opus 4.8

### 6.1 基础 API 调用：有条件地可以

Anthropic 的 Opus 4.8 官方说明明确表示：对已经运行在 Opus 4.7 的代码，迁移到 4.8 没有 breaking API change。

所以，如果同时满足：

- 现有 4.7 Messages API 请求本身正确；
- Team 账号实际开放 Opus 4.8；
- 订阅计费通道接受该客户端；
- 请求没有触发旧运行时不支持的特殊能力；

那么只把精确模型 ID 改成 `claude-opus-4-8`，**可能足以获得基本文本回复，甚至基础工具调用**。

这是“请求兼容性”的结论，不是“完整 Claude Code 2.1.154 兼容性”的结论。

### 6.2 远端 cc-haha 已经做了更广的 4.8 适配

远端提交：

```text
29b17c80  2026-07-22  fix(models): expose current Claude official lineup
```

该提交涉及 49 个文件，约 `+845/-154`，远大于 4.7 补丁的等量替换。它主要加入：

- `CLAUDE_OPUS_4_8_CONFIG` 和内部 `opus48`；
- 第一方 `claude-opus-4-8` 及各 provider 模型 ID；
- subscriber/第一方默认 Opus 4.8；
- 第三方兼容 provider 保留 4.7 默认值的分流；
- Team Premium/Max 与标准/Pro 的新默认模型策略；
- Opus 4.8、Sonnet 5、Fable 5 的 canonical/marketing 名称；
- 1M context、最大输出、effort、`xhigh`/`max`、adaptive thinking；
- Structured Outputs、beta、cost、provider env；
- CLI 和 Desktop 模型选择器；
- 相应单元测试与 UI 测试。

这已经不是“只改一个字符串”，而是一个比较像样的本地模型能力移植。

### 6.3 远端 4.8 适配仍不是官方 2.1.154 的完整实现

只读检查 `origin/main` 后仍可看到：

- 兼容版本仍固定为 `2.1.92`；
- Fast mode 的显示文本更新到 4.8，但实际支持判断仍只匹配 `opus-4-6`；
- Advisor 仍主要识别 4.6；
- Extra usage 仍主要识别 4.6；
- 部分 fallback 条件仍绑定 4.6；
- 没有官方 2.1.154 所有 prompt/harness、workflow 和错误修复的完整移植；
- `v0.4.11` 发布说明明确提示：实际模型可用性取决于账号/provider，并且没有覆盖所有真实 provider 组合的 live 验证。

官方 2.1.154 还把 4.8 与下列变化放在一起发布：

- 默认 effort 改为 high；
- Claude Code 新 workflow 行为；
- Fast mode；
- 对新模型使用 lean system prompt，而 4.7 及以下保留旧 prompt；
- 后续 2.1.156 修复“修改 Opus 4.8 thinking blocks 导致 API error”。

因此远端补丁的准确定位是：

> 它比 4.7 的替换补丁覆盖面大得多，足以成为 cc-haha 内部的 4.8 适配基线，但仍不是官方 Claude Code 2.1.154 的等价源码。

## 七、能否继续用同样方法迁移到 Opus 5

### 7.1 当前仓库状态

截至调研时：

- 本地 `a159ee35` 没有 Opus 5 配置；
- 远端 `47d47d18` 也没有正式的 `claude-opus-5` 配置和完整能力矩阵；
- `29b17c80` 加入的是 Opus 4.8、Fable 5 和 Sonnet 5，不包括 Opus 5；
- 精确字符串可能被本地解析器原样发送，但 UI、默认 alias、canonical 名称、能力判断、成本和 provider 映射并不了解它。

所以，直接发送精确 ID 是“未知模型透传”，不是“Opus 5 支持”。

### 7.2 Opus 5 不再只是无 breaking change 的模型替换

Anthropic 的 Opus 5 迁移说明指出，相对 4.8 至少有两个 breaking changes：

1. thinking 默认开启；
2. `thinking.disabled` 与 `xhigh`/`max` effort 的组合会返回 HTTP 400。

如果从 4.7 或 4.6 直接迁移，还要累计处理更多变化，例如：

- prompt 和 cache 行为变化；
- tool use 与 fallback 行为变化；
- 手动 extended thinking 的旧路径被移除或改变；
- 某些非默认 sampling 参数被拒绝；
- assistant prefill 行为变化；
- tokenizer 变化；
- 1M context 和 128K 输出能力；
- Fast mode 和模型选择策略变化。

官方 Claude Code 为 Opus 5 要求至少 2.1.219，也说明官方认为旧版 harness 不能被视为受支持组合。

### 7.3 “能返回一句话”不等于可以日常编码

社区中已经有某个 Claude 订阅 OAuth 插件的 2026-07-25 smoke test 显示：维护者账号上的 Opus 4.8 和 Opus 5 最小请求通过，但 Opus 5 的某个 Fast alias 探测失败。

这个结果只证明：

- 某个具体账号当时有模型 entitlement；
- 某种 token 和最小请求能到达模型；
- 新模型 ID 不是绝对被旧第三方客户端屏蔽。

它不能证明：

- Claude Team 账号普遍可用；
- 多轮工具调用正确；
- thinking block 能原样 round-trip；
- compaction、resume、prompt cache 正确；
- quota/overage 走正确的订阅计费通道；
- 第三方 OAuth 使用得到官方支持；
- cc-haha 当前运行时已经兼容。

### 7.4 如果要把 Opus 5 做成真正的产品支持

至少需要系统移植和验证：

- 模型配置、alias、canonical ID、显示名和 provider 映射；
- Team/Pro/Max 的默认选择逻辑，但不能假定 entitlement；
- effort：low/medium/high/xhigh/max；
- thinking 默认行为和非法参数组合；
- 1M context、128K output、token estimation；
- Structured Outputs、beta headers、prompt cache；
- tool use、thinking signature、streaming event parser；
- 多轮工具 round-trip、resume、compact；
- Fast mode、fallback、overage 和 quota；
- system prompt/harness 的模型分支；
- cost/usage/modelUsage 统计；
- API error 分类与降级；
- 单元测试、provider request-shape tests、多轮 fixture tests；
- 使用真实授权账号进行 live smoke，但不把测试账号可用性推广为所有 Team 账号的保证。

这更接近一次运行时移植，而不是一次字符串替换。

## 八、Claude Team OAuth 在 cc-haha 中实际上做了什么

本地 OAuth scope 包含：

```text
user:profile
user:inference
user:sessions:claude_code
user:mcp_servers
user:file_upload
```

见 [`src/constants/oauth.ts`](./src/constants/oauth.ts#L44)。

订阅用户创建 Anthropic client 时，本地逻辑会：

```ts
apiKey: null
authToken: getClaudeAIOAuthTokens()?.accessToken
```

见 [`src/services/api/client.ts`](./src/services/api/client.ts#L370)。

在 cc-haha 中，token 存放于：

```text
~/.claude/cc-haha/oauth.json
```

而项目设置主要读取：

```text
~/.claude/cc-haha/settings.json
~/.claude/cc-haha/providers.json
```

这说明 cc-haha 的确实现了 Claude 订阅 OAuth 登录和推理 token 的使用。但这段代码只完成身份认证和请求携带，不会在本地生成下列权限：

- 某个新模型的 entitlement；
- Team seat 的配额；
- organization 的 rollout；
- Max/Team Premium 才有的模型或额度；
- 订阅计费通道的服务端认可；
- 对旧客户端版本的豁免。

特别值得注意的是，4.7 提交 `c444e439` 和 `20806f40` 都没有修改 OAuth、订阅认证或服务端 entitlement 逻辑。这再次证明 4.7 能否调用，最终取决于当时服务端是否接受“已有 OAuth token + 新 model ID + 旧请求形状”这个组合。

## 九、公开社区实现和问题报告说明了什么

### 9.1 cc-haha 自身的版本门槛问题

cc-haha issue `#604` 报告：某公司代理拒绝 Opus 4.7，要求官方 Claude Code 2.1.111 或更高版本。维护者说明项目基于泄露 CLI 源码，不能直接升级成官方 CLI 版本；直接官方 Opus 4.7 和一些 relay 场景又可以工作，因此无法统一复现。

issue `#679` 对 Opus 4.8 报告了类似问题：第三方代理因为客户端版本过低而拒绝。维护者仍然指出泄露源码基线无法直接升级官方 CLI 版本。

这两个案例共同说明：

- 模型 ID 是一层；
- 客户端版本/兼容身份是另一层；
- 不同直连服务或代理的执行策略不同；
- 在一个入口成功，不能证明所有 Anthropic/Team/relay 入口都兼容。

### 9.2 OpenCode 以前为什么能用 Claude 订阅

用户记忆没有错：OpenCode 的旧版本曾通过内置或社区认证插件复用 Claude Pro/Max 订阅 OAuth。

但 OpenCode 当前官方 provider 文档说明：

- Anthropic 明确禁止这种 Pro/Max 订阅接入方式；
- OpenCode 从 1.3.0 起移除了相关内置插件；
- 当前官方路径回到 API key/provider 认证。

因此 OpenCode 的历史实现能证明“技术上曾经可行”，不能证明这条路径现在得到 Anthropic 支持，也不能作为 cc-haha 长期稳定适配的依据。

### 9.3 社区 OAuth 插件的 Opus 5 smoke test

`opencode-claude-auth` 的公开测试结果中，Opus 4.8 与 Opus 5 的最小 probe 在维护者账号上成功，14 个测试中 13 个通过、1 个 Fast 相关测试失败。

它的证据价值是“新模型可能对某些订阅 token 可达”。证据边界是“单账号、单实现、特定日期、最小请求”。它不能替代完整 agent-loop 验证，也不能消除服务条款风险。

### 9.4 Hermes：纯文本成功，工具请求却走错计费通道

Hermes issue `#15080` 报告了一个典型反例：同一个有效 Max OAuth token，简单或无工具请求可能成功；加入 tools 后却进入 overage/付费路径并失败，而调用官方 `claude` CLI 子进程可以工作。

这表明服务端可能根据请求形状、工具载荷或官方执行引擎上下文选择不同通道。拥有 token 和正确模型 ID，仍不足以复制官方 CLI 行为。

### 9.5 CLIProxyAPI：4.8 多轮 thinking block 失败

CLIProxyAPI issue `#3624` 报告 Opus 4.8 的多轮工具调用因为 thinking block 被修改或签名处理不正确而收到 400。

这正好说明：

> 第一轮成功不代表第二轮能把模型返回的 thinking/tool 状态按协议原样送回。

### 9.6 OmniRoute：成熟的 Opus 5 适配不是一行改名

OmniRoute 的 Opus 5 PR `#8464` 涉及模型目录、规格、价格、顺序、fallback、Fast mode、provider 路由、streaming、adaptive thinking、beta 和重试，并修改了大量文件。

它不是泄露 Claude Code 源码的等价实现，但可作为工程规模的旁证：成熟多 provider 路由器对新模型的适配也远超替换一个模型 ID。

### 9.7 本次检索没有找到什么

在本次公开检索范围内，没有找到一个可核验的第三方“Claude Code 泄露源码重组项目”，同时提供以下全部证据：

- 使用同一 Claude Team 订阅 OAuth；
- 稳定调用 Opus 5；
- 完整支持多轮工具、thinking、resume、compact、cache 和 Fast mode；
- 公布真实 Team live 验证矩阵；
- 得到 Anthropic 对第三方订阅 OAuth 的明确授权。

能找到的是分散的：

- 模型 ID 成功探测；
- 某个账号某一天可用；
- 某些 relay/代理兼容；
- 多轮工具或计费路径失败；
- 客户端版本被拒；
- 社区插件因政策变化被移除。

这组证据更支持“技术上有时可达，但不是稳定、完整、受支持的产品方案”。

## 十、订阅 OAuth 的官方支持和合规边界

Anthropic 官方 Team 文档确认：

- Team 的每个 seat 都包含 Claude Code；
- 用户可以在 Claude Code 中通过订阅登录；
- 登录时选择相应 Team organization。

但官方 Legal and Compliance 文档同时说明：

- OAuth token 面向购买订阅的用户在 Claude Code 和 Anthropic 原生应用中的普通使用；
- 第三方产品/服务开发者应使用 API key 或支持的云 provider；
- 第三方不应向用户提供 Claude.ai 登录或路由 Free/Pro/Max 凭据；
- Anthropic 可以对违规使用采取技术措施。

这里存在一个必须保守处理的细节：官方禁止条款的示例句对 Free/Pro/Max 写得最明确，而 Team 并不因此自动成为第三方 OAuth 的授权例外。前一层的“原生 Claude Code/Anthropic 应用”用途限定仍然存在。

Anthropic 另有官方 Agent SDK 文档，说明本地 Agent SDK、`claude -p` 和第三方 app 的订阅用量政策目前仍保持现状。比较合理的边界是：

- **在用户自己的机器或组织内部，通过官方 Claude Code/Agent SDK 执行**：有官方产品路径可依赖；
- **自己重写 OAuth 客户端并直接模仿 Claude Code 私有请求**：不属于稳定承诺的公开集成面；
- **公开分发或托管服务**：应使用 API key 或云 provider，不应收集/转发用户订阅凭据。

这不是纯粹的道德判断，而是工程风险：一条未受支持的认证通道可以在没有代码变更的情况下被服务端随时收紧。

## 十一、推荐的实现路线

### 路线 A：cc-haha 作为前端，官方 Claude Code/Agent SDK 作为执行引擎

这是最适合“继续使用自己的 Claude Team 订阅，并尽量总能跟上最新模型”的路线。

架构职责可以拆成：

```text
cc-haha
  ├─ CLI/Desktop UI
  ├─ 会话展示、项目管理、IM 适配
  ├─ 本地配置和编排
  └─ official-engine adapter
       └─ 最新官方 claude CLI / Claude Agent SDK
            ├─ 官方 OAuth
            ├─ /model 与 entitlement
            ├─ 最新 system prompt/harness
            ├─ 最新 tools/thinking/streaming 协议
            └─ Team 订阅计费
```

优点：

- 不需要在 cc-haha 里伪造官方客户端版本；
- 新模型、thinking、工具协议和 prompt 更新跟随官方引擎；
- Team 登录由官方流程管理；
- cc-haha 不必长期追踪私有请求细节；
- 相比直接 OAuth 重放，更接近官方允许和维护的使用方式。

需要评估：

- 官方 CLI/SDK 的 JSON 或 stream-json 输出；
- stdin/stdout、取消、权限确认和 session resume；
- cc-haha 工具与官方工具的职责边界；
- Desktop/Server/IM adapter 如何转发事件；
- 用户本地必须安装并更新官方执行引擎；
- Agent SDK 的当前订阅计费政策和未来变化。

### 路线 B：使用 Anthropic API、Bedrock、Vertex AI 或 Foundry

适合：

- 公开分发；
- 团队服务端部署；
- 需要稳定 SLA 和明确的开发者授权；
- 需要自定义 tool/harness，而不是复制官方 Claude Code。

代价是按 API 或云 provider 计费，不能把 Claude Team 聊天订阅简单等同于 API 额度。

### 路线 C：继续在泄露运行时里直连订阅 OAuth

只能把它定位为高维护、非官方支持的研究路径。

即使继续做，也应把目标写成：

> 验证某一账号、某一日期、某一模型和某一请求矩阵是否工作。

不能写成：

> 通过修改本地模型名，永久解锁所有未来 Opus。

这条路线需要持续跟踪：

- 官方模型 ID 和 provider 映射；
- entitlement 与 rollout；
- Claude Code 最低版本；
- OAuth/计费请求契约；
- effort/thinking/tool/prompt/cache 变化；
- 多轮 streaming parser；
- 服务端策略和 Terms 更新。

不建议通过冒充新版客户端或复刻私有校验来“修复”版本门槛。那不会自动带来新版协议实现，而且会把技术不兼容与账号风险叠加在一起。

## 十二、若要验证某个模型，最低测试矩阵是什么

不能只看下拉列表，也不能只看第一轮回复。至少要验证：

| 测试项 | 要证明的事实 |
| --- | --- |
| 官方最新版 Claude Code `/model` | 当前 Team seat/organization 是否真的开放模型 |
| 基础文本请求 | 精确 model ID 是否被服务端接受 |
| 响应 `message.model` / `modelUsage` | 是否实际返回目标模型，是否发生静默 remap/fallback |
| 单轮工具调用 | tool schema、tool_use、tool_result 是否正确 |
| 两轮以上工具调用 | thinking/signature/tool blocks 能否原样 round-trip |
| Adaptive thinking | 默认 thinking 和 effort 组合是否合法 |
| `xhigh` / `max` | 新 effort 等级是否真正生效而非仅 UI 可选 |
| Resume / Compact | 长会话状态和压缩是否兼容 |
| Prompt caching | cache key、阈值、system/tool 前缀是否正确 |
| 1M context / 最大输出 | 本地 token 限制和服务端限制是否一致 |
| Team quota / overage | 是否走订阅通道，而非错误进入 API/overage |
| Fast mode | 模型、账号、版本、计费和 fallback 是否同时兼容 |
| Provider-specific IDs | 第一方、Bedrock、Vertex、Foundry 分别验证 |
| 错误降级 | 429、400、模型不可用、版本不兼容时不静默换错模型 |

只有这些路径都通过，才可以把状态从“模型 ID 可达”提升到“cc-haha 对该模型具备可用支持”。

## 十三、对用户问题的直接回答

### 这份源码泄露之初使用的是 Opus 4.6 吗？

是。初始导入的实际配置和模型能力判断都以 Opus 4.6 为最高 Opus。

### 后来通过补丁就可以使用 Opus 4.7 吗？

有条件地是。补丁会把最终 API `model` 改成 4.7；服务端和账号接受时，实际远端模型可以是 4.7。但本地 harness 仍是旧基线，很多 4.7 能力没有迁移。

### 能不能同样改成 Opus 4.8？

基本调用层面很可能可以，因为官方说明 4.7→4.8 没有 breaking API change。远端 cc-haha 也已经提供了一个较广的 4.8 适配补丁。但账号 entitlement、旧客户端版本、thinking/tool 多轮协议和完整 Claude Code 行为仍需实测，不能只改默认字符串。

### 能不能同样改成 Opus 5？

不能把“改 ID 后某次请求成功”当成正式支持。Opus 5 有 breaking changes，当前 cc-haha 远端没有正式移植，官方最低 Claude Code 版本是 2.1.219。需要完整的运行时移植和验证，或直接使用最新版官方执行引擎。

### 同一个 Claude Team 订阅账号能不能在重组工具中使用最新 Opus？

技术上，某些第三方实现和账号在某些时间点确实能够通过订阅 token 到达新模型；但这不是账号的永久、本地可控权限，也不是官方保证的第三方集成方式。最稳妥的做法是让官方 Claude Code/Agent SDK 持有订阅登录和模型执行，cc-haha 只做上层产品；否则应使用正式 API/provider 凭据。

## 十四、证据来源

### 本地与 cc-haha

- 本地初始提交：`f5a40b86`
- 本地 Desktop 4.7 提交：`c444e439`
- 本地 4.7 替换提交：`20806f40`
- 本地兼容归因提交：`df60c774`
- [cc-haha 4.8/Fable 5/Sonnet 5 提交 `29b17c80`](https://github.com/NanmiCoder/cc-haha/commit/29b17c8028a55d3a0e854d6efb945f9cbdbedfcf)
- [cc-haha v0.4.11](https://github.com/NanmiCoder/cc-haha/releases/tag/v0.4.11)
- [cc-haha issue #604：Opus 4.7 与客户端版本](https://github.com/NanmiCoder/cc-haha/issues/604)
- [cc-haha issue #679：Opus 4.8 与客户端版本](https://github.com/NanmiCoder/cc-haha/issues/679)

### Anthropic 官方

- [Claude Code 模型配置、alias、账号可用性与最低版本](https://code.claude.com/docs/en/model-config)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude Opus 4.8 新特性与 4.7 迁移说明](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
- [Claude Opus 5 新特性](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Claude 模型迁移指南](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Team / Enterprise 订阅使用 Claude Code](https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan)
- [Claude Code 模型、用量和限制](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)
- [Claude Code Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [通过 Claude 订阅使用 Claude Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

### 社区实现与故障证据

- [OpenCode provider 文档：旧订阅认证插件的移除说明](https://opencode.ai/docs/providers)
- [OpenCode issue #6930：订阅 OAuth 账号风险个案](https://github.com/anomalyco/opencode/issues/6930)
- [opencode-claude-auth 模型 smoke test](https://github.com/griffinmartin/opencode-claude-auth/blob/main/test-results/model-smoke-test.json)
- [Hermes issue #15080：工具请求与订阅计费通道差异](https://github.com/NousResearch/hermes-agent/issues/15080)
- [CLIProxyAPI issue #3624：Opus 4.8 多轮 thinking block 错误](https://github.com/router-for-me/CLIProxyAPI/issues/3624)
- [OmniRoute PR #8464：Opus 5 适配范围](https://github.com/diegosouzapw/OmniRoute/pull/8464)
- [sub2api：第三方订阅转接实现及其 ToS 风险声明](https://github.com/Wei-Shaw/sub2api)

## 十五、最终判断

cc-haha 的 4.7 历史证明了一个有限但重要的事实：

> 对于服务端已经发布、账号已经授权、请求协议仍兼容的新模型，旧客户端通过修改实际 `model` 路由，确实可能提前或继续调用该模型。

它没有证明：

> 一个泄露源码快照只要不断替换模型名字，就能永久继承未来所有 Claude Code 模型、工具、提示词、计费和订阅权限。

Opus 4.8 尚处在“基础 API 兼容较好、可通过较完整补丁适配”的范围；Opus 5 已经进入“需要明确处理 breaking changes 和完整 agent-loop 协议”的范围。

从工程稳定性、订阅可用性和合规边界综合考虑，最佳方案是把最新版官方 Claude Code/Agent SDK 作为可升级的执行后端，而不是继续让 cc-haha 自己冒充和追赶官方私有客户端。
