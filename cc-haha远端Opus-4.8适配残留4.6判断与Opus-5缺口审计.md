# cc-haha 远端 Opus 4.8 适配、残留 4.6 判断与 Opus 5 缺口审计

> 审计日期：2026-07-26
> 本地 `HEAD`：`a159ee35`
> 审计目标：远端 `origin/main`，提交 `47d47d18`
> 4.8 模型适配提交：`29b17c80`
> 审计方式：远端 Git 树静态检查、精确模型能力函数探测、focused tests、Anthropic 官方文档对照

## 一、直接结论

### 1.1 Opus 4.8

远端的 Opus 4.8 适配**已经修复了 4.7 补丁中最主要的一批 4.6 遗留问题**：

- 实际模型配置和默认路由；
- canonical model 映射；
- effort；
- `xhigh` 和 `max` effort；
- direct Anthropic API / Foundry 的 adaptive thinking；
- 1M context；
- 128K 最大输出；
- Structured Outputs；
- context management；
- 成本、显示名和 system prompt 环境元数据；
- CLI、Desktop、Server 模型选择；
- 一批单元测试和设置/API 测试。

因此不能再说“Opus 4.8 仍然和本地 4.7 一样，所有能力都残留在 4.6 判断上”。

但是，它也**没有完全解决**。目前可以确认的主要缺口是：

1. **Fast mode 是明确错误的。** 显示名已改为 Opus 4.8，`opus` alias 也解析为 4.8，但真正的支持判断仍只匹配 `opus-4-6`。
2. **Advisor 没有迁移。** 运行时仍只允许 Opus 4.6 和 Sonnet 4.6；官方当前文档明确写着 Opus 4.6 或更高版本都支持 Advisor。
3. **第三方模型不可用时的 fallback 仍是旧的 4.6 判断。** 它连实际的 4.7 配置都匹配不到，也没有 4.8 的 fallback chain。
4. **Bedrock/Vertex 的 4.8 adaptive thinking 没有内建开启。** 代码认定 4.8 “能思考但不支持 adaptive”，默认会落入手动 `thinking.enabled + budget_tokens` 路径；而官方说明 Opus 4.8 只支持 adaptive thinking。除非 provider capability override 明确开启 adaptive，否则存在 400 风险。
5. **设置 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 会让 4.8 落入手动 thinking 路径。** 这同样与 4.8 只接受 adaptive thinking 的官方协议冲突。
6. **官方 2.1.154 的 lean system prompt 没有移植。** `29b17c80` 只更新了旧 prompt 中的模型名、模型 ID 和 knowledge cutoff。
7. **兼容版本仍为 `2.1.92`。** 这低于官方 Opus 4.8 要求的 Claude Code 2.1.154；模型 ID 支持不等于客户端协议身份已经升级。
8. **没有 Fast、Advisor、4.8 fallback 和 Opus 5 的对应测试。**

所以对 Opus 4.8 的准确评价是：

> 它已经从“模型名替换补丁”提升为“覆盖主要模型能力的适配”，direct Anthropic API 的普通 4.8 agent loop 明显比本地 4.7 完整；但 Fast、Advisor、部分 provider thinking、fallback、lean prompt 和客户端版本仍未对齐官方 Claude Code。

### 1.2 Opus 5

远端**不存在 Opus 5 适配**。

在整个 `origin/main` 上搜索：

```text
claude-opus-5
Opus 5
opus-5
```

结果为零。`29b17c80` 加入的是：

- Claude Fable 5；
- Claude Opus 4.8；
- Claude Sonnet 5。

它没有加入 Claude Opus 5。

截至 `origin/main=47d47d18`：

- `opus` alias 仍解析到 Opus 4.8；
- 没有 `CLAUDE_OPUS_5_CONFIG`；
- 没有 `opus50` 或相应 model key；
- 没有 Opus 5 canonical mapping；
- 没有 Opus 5 effort/thinking/context/Structured Outputs/Fast/Advisor/cost 分支；
- 没有 Opus 5 测试；
- `29b17c80` 之后，相关模型运行时文件没有新的提交。

精确传入 `claude-opus-5` 虽然会被请求解析器透传，但运行时探测结果是：

```json
{
  "parsed": "claude-opus-5",
  "canonical": "claude-opus",
  "effort": false,
  "xhigh": false,
  "maxEffort": false,
  "thinking": true,
  "adaptiveThinking": false,
  "requiresThinking": false,
  "supports1M": false,
  "contextWindow": 200000,
  "outputTokens": {
    "default": 32000,
    "upperLimit": 64000
  },
  "structuredOutputs": false,
  "advisorMain": false,
  "advisorTarget": false
}
```

官方 Opus 5 实际是：

- 1M context；
- 128K max output；
- adaptive thinking 默认开启；
- effort 支持 `low/medium/high/xhigh/max`；
- Fast mode；
- Structured Outputs；
- Opus 4.7 或更高版本可参与 Advisor。

当前 cc-haha 对精确 Opus 5 的本地判断几乎全部不匹配。

更严重的是：当前默认 thinking 开启时，cc-haha 很可能为 Opus 5 构造：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": "<fixed budget>"
  }
}
```

而 Anthropic 官方迁移指南明确说明，Opus 5 不再接受这种手动 extended thinking 配置；应该使用 adaptive thinking 或省略 thinking 字段。因此它不是“功能少一点”，而是可能直接得到 HTTP 400。

## 二、审计范围和证据等级

本报告把证据分为四类：

| 等级 | 含义 |
| --- | --- |
| 已验证 | 由 `origin/main` 代码、实际函数输出或 focused tests 直接证明 |
| 明确缺陷 | 本地代码内部自相矛盾，或与当前官方文档直接冲突 |
| 行为差异 | 与官方 Claude Code 不一致，但可能是 cc-haha 有意裁剪 |
| 未证明 | 缺少 live provider/Team OAuth 验证，不能仅靠单测下结论 |

本次没有把所有出现 `opus-4-6` 的代码一律判定为 bug。一个旧模型判断可能是：

- 有意保留的 backward compatibility；
- 已经无法命中的死分支；
- 与旧订阅计费逻辑绑定；
- 真正忘记迁移的新模型能力判断。

只有结合调用前是否经过 canonicalization、alias 如何解析、provider 分支和官方能力表，才能判断。

## 三、远端到底加入了哪些模型

`29b17c80`：

```text
fix(models): expose current Claude official lineup
49 files changed, 845 insertions(+), 154 deletions(-)
```

新增的核心配置是：

```ts
export const CLAUDE_FABLE_5_CONFIG = {
  firstParty: 'claude-fable-5',
  // ...
}

export const CLAUDE_SONNET_5_CONFIG = {
  firstParty: 'claude-sonnet-5',
  // ...
}

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  // ...
}
```

注册键为：

```ts
fable5
sonnet50
opus48
```

旧变量仍然存在：

```ts
export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-7',
  // ...
}
```

也就是说：

- `CLAUDE_OPUS_4_6_CONFIG` / `opus46` 是历史命名债务，实际值是 Opus 4.7；
- 新 4.8 使用独立的 `CLAUDE_OPUS_4_8_CONFIG` / `opus48`；
- 代码中没有任何 Opus 5 config。

远端默认路由：

```ts
export function getDefaultOpusModel(): ModelName {
  // ...
  if (shouldUseThirdPartyAnthropicModelDefaults()) {
    return getModelStrings().opus46 // 实际是 Opus 4.7
  }
  return getModelStrings().opus48 // Opus 4.8
}
```

因此：

| 场景 | `opus` alias |
| --- | --- |
| Anthropic subscription / direct first-party | Opus 4.8 |
| Anthropic API first-party | Opus 4.8 |
| 保守的第三方兼容 provider 默认 | Opus 4.7 |
| Opus 5 | 不会自动选择 |

## 四、Opus 4.8 能力逐项审计

### 4.1 模型路由：已解决

4.8 有独立配置：

```text
firstParty: claude-opus-4-8
bedrock: anthropic.claude-opus-4-8
vertex: claude-opus-4-8
foundry: claude-opus-4-8
azureOpenAI: claude-opus-4-8
```

`opus` alias 在第一方场景解析到 `opus48`，最终 API `model` 是 `claude-opus-4-8`。

这不是只改 UI。

### 4.2 Canonical mapping 和显示名：已解决

远端明确加入：

```ts
if (name.includes('claude-opus-4-8')) {
  return 'claude-opus-4-8'
}
```

并支持：

- `Opus 4.8`；
- `Opus 4.8 (with 1M context)`；
- commit attribution；
- Desktop/Server model catalog；
- prompt environment 中的公开模型名。

### 4.3 Effort：主要问题已解决

4.8 被加入：

- `modelSupportsEffort()`；
- `modelSupportsXHighEffort()`；
- `modelSupportsMaxEffort()`。

实测 direct Anthropic API 能力：

```text
effort       true
xhigh        true
max          true
```

这与当前官方能力表一致：Opus 4.8 支持 `low/medium/high/xhigh/max`。

`getDefaultEffortForModel()` 没有把 4.8加入旧的 4.6/4.7 `medium` 特殊分支，而是返回 `undefined`，由 API 解析为 high。

这是**正确行为，不是遗漏**。官方 2.1.154 明确说 Opus 4.8 默认 high。

旧分支：

```ts
if (
  model.includes('opus-4-6') ||
  model.includes('opus-4-7')
) {
  // Pro / 部分 Max/Team 使用 medium
}
```

只是在保留旧模型的历史订阅策略，不应该机械地把 4.8 加进去。

### 4.4 Adaptive thinking：第一方已解决，provider 覆盖不完整

direct Anthropic API 探测：

```text
modelSupportsThinking('claude-opus-4-8')         true
modelSupportsAdaptiveThinking('claude-opus-4-8') true
```

正常请求会发送：

```json
{
  "thinking": {
    "type": "adaptive"
  }
}
```

这与官方协议一致。

但是按 provider 实测：

```text
provider      thinking   adaptive
firstParty    true       true
bedrock       true       false
vertex        true       false
foundry       true       true
```

代码逻辑是：

```ts
if (!isFirstPartyBaseUrl && provider !== 'foundry') {
  return false
}
```

当 thinking 默认开启但 adaptive 判定为 false 时，请求构造器不会简单省略 thinking，而会发送：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 32000
  }
}
```

官方文档说明 Opus 4.8 只支持 adaptive thinking，手动 `type: enabled` 会被拒绝。

因此：

- direct Anthropic API：这部分正确；
- Foundry：代码认为正确；
- Bedrock/Vertex：如果没有 provider capability override，存在协议错误风险；
- 自定义 `ANTHROPIC_BASE_URL` relay：默认保守关闭 adaptive，需要显式 capability override，否则可能走手动 thinking。

这是 4.8 适配中比“残留一个 4.6 字符串”更实质的问题。

### 4.5 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`：明确兼容性风险

请求构造代码：

```ts
if (
  !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
  modelSupportsAdaptiveThinking(options.model)
) {
  thinking = { type: 'adaptive' }
} else {
  thinking = {
    type: 'enabled',
    budget_tokens: thinkingBudget,
  }
}
```

因此只要用户设置：

```text
CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
```

即使 4.8 已经被正确识别为 adaptive 模型，也会强制走手动 thinking。

Anthropic 当前文档明确指出：

- Opus 4.7、Opus 4.8、Opus 5、Sonnet 5、Fable 5 不接受旧式 manual extended thinking；
- 对这类模型应使用 adaptive thinking；
- 旧 Claude Code 中的“禁用 adaptive，回到固定 budget”逻辑不能继续机械复用。

当前测试没有覆盖“4.8 + `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`”的请求形状。

### 4.6 1M context：已解决

远端把 4.8 加入：

```ts
modelSupports1M()
DIRECT_MODEL_CONTEXT_WINDOWS
PATTERN_MODEL_CONTEXT_WINDOWS
```

实测：

```text
getContextWindowForModel('claude-opus-4-8') = 1_000_000
```

这与官方 4.8 native 1M 能力一致。

### 4.7 最大输出：已解决

4.8 被加入 64K 默认、128K upper limit 分支：

```text
default     64,000
upperLimit 128,000
```

这与官方 128K max output 一致。

### 4.8 Structured Outputs：已解决

4.8 被加入 Structured Outputs allowlist。

direct Anthropic API / Foundry 的能力判断为 true；其他 provider 仍按代码中的 provider 限制处理。

### 4.9 Context management：已解决

`modelSupportsContextManagement()` 通过 `claude-opus-4` family 匹配覆盖 4.8。

direct Anthropic API 测试也断言：

```text
modelSupportsContextManagement('claude-opus-4-8') = true
```

### 4.10 成本：标准成本已解决，Fast 成本没有完整迁移

`MODEL_COSTS` 有独立 4.8 标准成本项。

但是 Fast mode 的特殊成本函数仍叫：

```text
getOpus46CostTier()
getOpus46PricingSuffix()
```

并且 `getModelCosts()` 的 Fast 特殊分支只识别历史 `CLAUDE_OPUS_4_6_CONFIG`，其实际 canonical 值是 4.7，不是 4.8。

所以：

- 4.8 标准成本：有配置；
- 4.8 Fast 成本：没有通过当前特殊分支正确识别；
- 4.8 Fast 本身又被 `isFastModeSupportedByModel()` 阻断。

### 4.11 Prompt 环境元数据：已更新

`29b17c80` 更新了：

- `FRONTIER_MODEL_NAME = 'Claude Opus 4.8'`；
- Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 模型 ID；
- knowledge cutoff；
- “Fast mode 使用相同 Opus 4.8 模型”说明。

但是这不是官方 2.1.154 lean prompt 的完整移植。

官方 changelog 写明：

> 2.1.154 开始，除 Haiku、Sonnet 和 Opus 4.7 及更早模型外，lean system prompt 成为默认。

远端代码没有按模型选择 lean system prompt 的实现；搜索 `lean system prompt` 或相应 4.8 prompt 分支没有结果。这里仍使用泄露源码基线的完整 prompt，只更新其中少量模型元数据。

## 五、明确仍然残留的 4.6 判断

### 5.1 Fast mode：确定是 bug

远端代码：

```ts
export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.8'

export function getFastModeModel(): string {
  return 'opus' + (...)
}

export function isFastModeSupportedByModel(modelSetting): boolean {
  const parsedModel = parseUserSpecifiedModel(modelSetting)
  return parsedModel.toLowerCase().includes('opus-4-6')
}
```

在第一方场景：

```text
opus → claude-opus-4-8
```

于是：

```text
'claude-opus-4-8'.includes('opus-4-6') = false
```

内部形成直接矛盾：

| 层 | 值 |
| --- | --- |
| Fast 显示名 | Opus 4.8 |
| Fast 目标 alias | `opus` |
| `opus` 实际解析 | Opus 4.8 |
| Fast 支持判定 | 只允许 Opus 4.6 |
| 最终结果 | Opus 4.8 被判定为不支持 |

查看 `29b17c80` diff 可以确认，该提交在 `fastMode.ts` 中只改了这一行：

```diff
- export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.7'
+ export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.8'
```

它没有修改真正的支持 predicate。

Anthropic 当前官方 Fast mode 文档明确说：

- Fast mode 支持 Opus 5 和 Opus 4.8；
- Opus 4.7 已于 2026-07-24 移除；
- 其他模型不支持。

所以这个残留不是“为了旧模型兼容”，而是和当前官方行为相反。

### 5.2 Advisor：确定没有迁移

远端代码：

```ts
export function modelSupportsAdvisor(model: string): boolean {
  return (
    model.includes('opus-4-6') ||
    model.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}
```

`isValidAdvisorModel()` 也是相同判断。

实测：

```text
model                main supports advisor   valid advisor target
claude-opus-4-6      true                    true
claude-opus-4-7      false                   false
claude-opus-4-8      false                   false
claude-opus-5        false                   false
```

Anthropic 当前官方 Advisor 文档明确说明：

- supported main model 是 Opus 4.6 或更高；
- Opus 4.7 或更高可以使用同级或更高 Opus advisor；
- 可传入 `claude-opus-5` 作为 advisor；
- Advisor 只支持 Anthropic API，不支持 Bedrock/Vertex/Foundry。

因此 cc-haha 不只是漏了 4.8，也漏了 4.7、Sonnet 5 和 Opus 5 的 Advisor 能力与模型等级判断。

### 5.3 第三方 fallback：确定是过期判断

API 错误 fallback：

```ts
// 注释说：Opus 4.7 variant
if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
  return getModelStrings().opus41
}
```

模型验证 fallback 同样只匹配 `opus-4-6`。

但当前历史配置：

```text
opus46 → claude-opus-4-7
```

所以失败的实际 4.7 ID 根本不会进入这个条件，4.8 更不会。

影响：

- 4.7/4.8 在第三方 provider 上不可用时没有预期的 fallback suggestion；
- 注释与代码不一致；
- 官方当前的 Fable 5 / Opus 5 分类器 fallback chain 完全不存在。

这主要影响错误恢复，不会改变一个成功请求使用的模型。

### 5.4 EffortCallout：过期、基本成为死逻辑

代码注释：

```text
Only show for Opus 4.7 for now
```

实际判断：

```ts
if (!parsed.toLowerCase().includes('opus-4-6')) {
  return false
}
```

当前：

- `opus` 解析为 4.8；
- 精确 4.7 仍是 4.7；
- 两者都不包含 4.6。

因此这个 callout 对主流 4.7/4.8 都不会显示。

这不是 4.8 请求失败的原因，但证明模型迁移没有完成清理。

### 5.5 Commit attribution：历史命名债务

代码：

```ts
if (shortName.includes('opus-4-8')) return 'claude-opus-4-8'
if (shortName.includes('opus-4-6')) return 'claude-opus-4-7'
```

4.8 有独立且正确的映射，所以不会受后一行影响。

后一行表示仓库继续把某些历史 4.6/internal 名称公开成 4.7。它是容易误导维护者的结构债务，但不是 4.8 路由 bug。

### 5.6 `extraUsage.ts`：不能直接判为 bug

`extraUsage.ts` 仍只识别：

```ts
const isOpus46 = m === 'opus' || m.includes('opus-4-6')
const isSonnet46 = m === 'sonnet' || m.includes('sonnet-4-6')
```

该函数服务于旧 `[1m]` / Fast extra usage 计费提示。Opus 4.8 本身是 native 1M，远端还引入了 1M merge 逻辑。

仅凭这里没有 `opus-4-8`，无法证明 4.8 计费一定错误。需要真实订阅响应和 usage-credit 行为才能判断。

可以确认的是：

- 命名仍绑定旧 Opus46；
- Fast path 已经另有明确错误；
- 没有 live Team/Max 计费测试证明 4.8 extra usage 提示正确。

### 5.7 FileRead mitigation exemption：行为差异，不能仅凭源码判错

远端仍然只有：

```ts
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-7'])
```

因此 Opus 4.8 会收到 FileRead 的 cyber-risk reminder，4.7 不会。

这可能是：

- 忘记迁移；
- 有意只豁免经过验证的 4.7；
- 4.8 safety behavior 发生变化。

没有模型 launch DRI 或公开官方说明时，不能武断地把 4.8 加进 exemption。本报告将其归类为“未解释的行为差异”，不是已证实 bug。

## 六、哪些 4.6 判断其实不是 4.8 bug

### 6.1 Effort allowlist 中保留 4.6

下面这种写法是合理的多版本支持：

```ts
m.includes('opus-4-6') ||
m.includes('opus-4-7') ||
m.includes('opus-4-8')
```

4.8 已经在同一 allowlist 中，保留 4.6 不会把 4.8 降级。

### 6.2 1M / output 分支中同时保留旧模型

`context.ts` 同时列出 4.6、4.7、4.8，是在表达多版本 capability，并不意味着 4.8 会走 4.6。

但这里还有一个独立的 canonicalization 债务：

```text
getCanonicalName('claude-opus-4-6') = 'claude-opus-4'
```

因为 canonical mapper 没有独立的 4.6 分支，精确 4.6 会先被通用 `claude-opus-4` 捕获。

实测精确 4.6：

```text
context window  200,000
max output      32,000
adaptive        false
structured      false
```

所以部分 `canonical.includes('opus-4-6')` 条件实际上无法命中，是死条件或至少不能覆盖精确一方模型 ID。

这说明代码里仍有历史不一致，但不会阻止已经有独立 canonical mapping 的 4.8。

### 6.3 4.8 默认 effort 不进入 4.7 medium 分支

如前所述，4.8 官方默认 high。没有把 4.8 加入旧 medium 分支是正确的。

## 七、Opus 5 为什么不能靠精确 ID 透传获得完整支持

### 7.1 精确 ID 会透传，但 canonicalization 丢失版本

解析器：

```text
parseUserSpecifiedModel('claude-opus-5')
→ 'claude-opus-5'
```

这允许 API 请求体包含精确 ID。

但 canonicalizer 没有 Opus 5 分支，最后的通用正则只得到：

```text
getCanonicalName('claude-opus-5')
→ 'claude-opus'
```

后续所有依赖 canonical family/version 的能力判断都无法识别 5。

### 7.2 Effort 全部关闭

`modelSupportsEffort()` 遇到含 `opus`、但不在显式 allowlist 中的模型时返回 false。

所以 Opus 5：

```text
effort      false
xhigh       false
max         false
```

官方 Opus 5 支持完整五档 effort。

### 7.3 Thinking 请求可能直接非法

cc-haha 默认 thinking config：

```ts
{ type: 'adaptive' }
```

请求构造时并不直接信任这个值，而是重新检查模型 capability：

```text
modelSupportsThinking(Opus 5)         true
modelSupportsAdaptiveThinking(Opus 5) false
```

于是走到：

```ts
thinking = {
  type: 'enabled',
  budget_tokens: thinkingBudget,
}
```

官方 Opus 5 迁移规则：

- thinking 默认开启；
- manual `thinking.enabled + budget_tokens` 已移除；
- `thinking.disabled + effort xhigh/max` 返回 400；
- 应省略 thinking 字段或使用 adaptive thinking。

所以默认 cc-haha 请求很可能在服务端模型 entitlement 校验之后，继续因 thinking shape 被拒绝。

### 7.4 Context 和输出上限错误

当前 Opus 5 探测：

```text
context window  200,000
default output   32,000
upper output     64,000
```

官方：

```text
context window 1,000,000
max output       128,000
```

即使服务端接受较小的值，本地也会：

- 提前 compact；
- 错误计算 context remaining；
- 限制长任务；
- 无法利用 128K 输出；
- 影响 resume 和 token budgeting。

### 7.5 Structured Outputs、Fast、Advisor、cost 都缺失

当前精确 Opus 5：

```text
Structured Outputs false
Fast               false
Advisor main       false
Advisor target     false
marketing name     undefined
cost               unknown/default fallback
```

这不是“残留少量 4.6 判断”，而是没有 Opus 5 model launch port。

## 八、测试覆盖真实说明了什么

在从 `origin/main` 导出的临时只读代码树中运行：

```text
bun test \
  src/utils/model/fable.test.ts \
  src/utils/__tests__/thinking.test.ts \
  src/utils/effort.agent.test.ts
```

结果：

```text
29 pass
0 fail
```

继续运行：

```text
bun test \
  src/services/api/claudeRequiredThinking.test.ts \
  src/server/__tests__/settings.test.ts
```

结果：

```text
70 pass
0 fail
```

合计：

```text
99 pass
0 fail
```

这些测试证明：

- 4.8 config、canonical mapping 和显示名正确；
- 4.8 direct first-party thinking/adaptive capability 正确；
- effort/xhigh/max capability 表包含 4.8；
- 4.8 1M context 正确；
- Fable required adaptive thinking 正确；
- Server/Desktop 设置和默认模型能暴露 4.8。

这些测试没有证明：

- Fast mode 对 4.8 可用；
- 4.8 Fast 价格正确；
- Advisor 对 4.8 可用；
- 4.8 在 Bedrock/Vertex 的 thinking request 合法；
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 与 4.8 兼容；
- 4.8 thinking block 多轮 round-trip 等价于官方 2.1.156；
- 第三方 fallback 正确；
- Claude Team OAuth 实际服务端接受 4.8；
- Opus 5 可用。

仓库中没有找到 Fast、Advisor 或 Opus 5 的相应模型测试。

所有本次运行的测试都是本地 unit/mock/request-shape 范围，没有调用真实 Anthropic Team 账号。

## 九、与官方 Claude Code 的关键差异

| 能力 | 官方 2.1.154+ Opus 4.8 | cc-haha `origin/main` |
| --- | --- | --- |
| 模型 ID | 4.8 | 已实现 |
| 默认 effort | high | 已实现 |
| xhigh/max | 支持 | 已实现 |
| Adaptive thinking | 唯一支持的 thinking 模式 | direct 1P/Foundry 已实现；Bedrock/Vertex 有缺口 |
| 1M context | 支持 | 已实现 |
| 128K output | 支持 | 已实现 |
| Structured Outputs | 支持 | 1P/Foundry 已实现 |
| Fast mode | 支持 4.8 | 显示 4.8，但 predicate 只认 4.6 |
| Advisor | Opus 4.6+ | 只认 4.6 |
| Lean system prompt | 4.8 默认使用 | 未移植 |
| Thinking block 修复 | 2.1.156 修复过 4.8 API error | 有自己的保护逻辑，但未证明等价 |
| 最低 Claude Code 版本 | 2.1.154 | 兼容版本仍为 2.1.92 |

Opus 5：

| 能力 | 官方 2.1.219+ | cc-haha `origin/main` |
| --- | --- | --- |
| 模型 config/alias | `opus → claude-opus-5` | 不存在，alias 仍是 4.8 |
| Canonical mapping | Opus 5 | 丢失为 `claude-opus` |
| Thinking | adaptive 默认开启 | 误判 adaptive=false，可能发送非法 manual thinking |
| Effort | 五档 | 全部 false |
| Context | 1M | 200K fallback |
| Max output | 128K | 64K upper fallback |
| Fast | 支持 | 不支持 |
| Structured Outputs | 支持 | false |
| Advisor | 支持 | false |
| 测试 | 官方 2.1.219 release | 无 |

## 十、对“还残留 4.6 判断吗”的精确回答

**有残留，但不能一概而论。**

### 已经解决的

- 4.8 model ID；
- effort；
- xhigh/max；
- direct first-party adaptive thinking；
- 1M；
- 128K output；
- Structured Outputs；
- context management；
- 标准成本；
- UI/metadata。

### 仍是明确问题的

- Fast mode；
- Advisor；
- 4.7/4.8 third-party fallback；
- 4.8 在 Bedrock/Vertex 上的 adaptive thinking；
- 禁用 adaptive 后回退到非法 manual thinking；
- Fast 成本；
- 兼容版本；
- 没有 lean prompt。

### 只是历史或 backward-compatibility 的

- effort allowlist 同时保留 4.6/4.7/4.8；
- 旧 4.7 medium effort 策略；
- 第三方默认仍保守使用 4.7；
- extra usage 的部分旧模型命名。

### 已成为死分支或命名债务的

- canonicalization 后仍检查 `opus-4-6` 的部分条件；
- `CLAUDE_OPUS_4_6_CONFIG` 实际存放 4.7；
- `opus46` / `getOpus46*` 被继续用于 4.7，部分 UI helper 又服务 4.8；
- EffortCallout 注释说 4.7、代码却检查 4.6。

## 十一、最终判断

### Opus 4.8

远端适配已经解决本地 4.7 补丁最明显的 effort、thinking、1M 和输出上限问题。对于 direct Anthropic API 的普通请求，它是一个实质性升级，不是只换名字。

但它还不能被称为完整 Claude Code 2.1.154/2.1.156 移植。Fast、Advisor、部分 provider thinking、fallback、lean prompt 和版本兼容仍有明确差距。

### Opus 5

远端没有适配。

精确 ID 透传最多能让服务端看到 `claude-opus-5`，但当前运行时随后会：

- 把 canonical version 丢掉；
- 关闭 effort；
- 误判 adaptive thinking；
- 使用 200K/64K 本地限制；
- 关闭 Structured Outputs、Fast 和 Advisor；
- 在默认 thinking 路径上可能构造 Opus 5 明确拒绝的请求。

因此不能把它描述为“Opus 5 已适配但还残留 4.6 判断”。准确说法是：

> Opus 4.8 已完成主要能力适配但仍有若干 4.6 遗留缺陷；Opus 5 尚未开始正式的 model-launch 适配。

## 十二、证据来源

### cc-haha

- [4.8/Fable 5/Sonnet 5 适配提交 `29b17c80`](https://github.com/NanmiCoder/cc-haha/commit/29b17c8028a55d3a0e854d6efb945f9cbdbedfcf)
- [远端审计树 `47d47d18`](https://github.com/NanmiCoder/cc-haha/tree/47d47d18)
- [远端模型配置](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/model/configs.ts)
- [远端 effort 判断](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/effort.ts)
- [远端 thinking 判断](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/thinking.ts)
- [远端请求 thinking 构造](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/services/api/claude.ts)
- [远端 context/output 判断](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/context.ts)
- [远端 Fast mode 判断](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/fastMode.ts)
- [远端 Advisor 判断](https://github.com/NanmiCoder/cc-haha/blob/47d47d18/src/utils/advisor.ts)

### Anthropic 官方

- [Claude Code model configuration：当前 aliases、最低版本、effort、context](https://code.claude.com/docs/en/model-config)
- [Claude Code Fast mode：Opus 5/4.8 支持和 4.7 移除](https://code.claude.com/docs/en/fast-mode)
- [Claude Code Advisor：支持模型和模型等级](https://code.claude.com/docs/en/advisor)
- [Claude Code changelog：2.1.154、2.1.156、2.1.219](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Opus 5 migration guide：thinking breaking changes](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Adaptive thinking：4.8/5 thinking 模式](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)

## 十三、远端最新版实际会向 Anthropic 请求 Opus 4.8，还是 Opus 4.6

### 13.1 结论

在以下条件下，远端最新版实际发送给 Anthropic 的模型 ID 是 **`claude-opus-4-8`，不是 Opus 4.6**：

- 使用包含 `29b17c80` 的远端新版本；
- 走 Anthropic 官方订阅/OAuth 或 Anthropic direct first-party API；
- 精确指定 `claude-opus-4-8`，或者使用在该场景下解析到 4.8 的 `opus` alias；
- 服务端接受该账号和请求。

需要纠正一个术语：Anthropic 通常不是给每个模型提供不同的 HTTP endpoint URL。客户端仍然调用 Messages API 一类的公共 endpoint，真正决定模型的是请求体中的 `model` 字段。

精确指定：

```text
--model claude-opus-4-8
```

最终请求的关键部分是：

```json
{
  "model": "claude-opus-4-8"
}
```

`normalizeModelStringForAPI()` 只会去掉 `[1m]` / `[2m]` 这类本地后缀，不会把 4.8 改成 4.6 或 4.7。

### 13.2 使用 `opus` alias 时的解析过程

在官方订阅或 Anthropic first-party 场景：

```text
--model opus
  → parseUserSpecifiedModel('opus')
  → getDefaultOpusModel()
  → getModelStrings().opus48
  → CLAUDE_OPUS_4_8_CONFIG.firstParty
  → claude-opus-4-8
  → request.body.model
```

所以这里最终也是：

```json
{
  "model": "claude-opus-4-8"
}
```

### 13.3 为什么代码里还能看到 `opus46` 和 `CLAUDE_OPUS_4_6_CONFIG`

这是历史命名债务，不代表当前请求仍然使用 Opus 4.6。

远端代码实际是：

```ts
export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-7',
  // ...
}
```

所以旧键：

```text
opus46
CLAUDE_OPUS_4_6_CONFIG
```

当前实际代表的是 **Opus 4.7**，已经不是 4.6。

新的第一方默认 Opus 使用另一套独立配置：

```text
opus48
CLAUDE_OPUS_4_8_CONFIG
claude-opus-4-8
```

因此第一方 `opus` alias 不会经过旧 `opus46` 配置。

### 13.4 第三方 provider 是例外

如果使用 Anthropic-compatible relay、Bedrock、Vertex 或其他第三方 provider，并且进入 `shouldUseThirdPartyAnthropicModelDefaults()` 分支，裸 `opus` alias 会保守选择：

```text
getModelStrings().opus46
```

但这个值实际是：

```text
claude-opus-4-7
```

所以第三方默认通常是 **Opus 4.7，也不是 Opus 4.6**。

如果第三方 provider 已经支持 4.8，可以通过其受支持的精确模型 ID、provider model mapping 或项目提供的 model override 指定 4.8；是否成功取决于该 provider 的模型名称和能力声明。

### 13.5 残留的 4.6 判断会不会把请求偷偷降级

正常 4.8 请求中，前文发现的这些残留：

- Fast mode predicate；
- Advisor allowlist；
- fallback suggestion；
- EffortCallout；
- 部分旧计费/显示 helper；

主要影响的是功能是否开启、错误提示、价格展示或失败后的恢复路径。

它们不会在普通成功请求中把：

```text
claude-opus-4-8
```

静默改写为：

```text
claude-opus-4-6
```

例如 Fast mode 的当前问题是把 4.8 判定为“不支持 Fast”，而不是自动切回 4.6。Bedrock/Vertex adaptive thinking 的问题也更可能表现为参数错误或 HTTP 400，而不是本地改成 4.6。

### 13.6 如何确认服务端最终实际返回的模型

本地请求体证明客户端申请的是 4.8；要确认服务端最终执行和返回的模型，还应检查响应中的：

```text
message.model
modelUsage
```

理想结果应包含：

```text
claude-opus-4-8
```

这一步可以排除：

- 账号没有 4.8 entitlement；
- organization model restriction；
- 服务端自动 fallback；
- relay 静默 remap；
- provider 自己的模型别名映射。

因此最终结论分为两层：

1. **客户端本地行为已经确定：**远端最新版在第一方场景指定 4.8 时，发出的 `model` 是 `claude-opus-4-8`，不会被本地改成 4.6。
2. **服务端实际模型仍应以响应为准：**请求成功且 `message.model` / `modelUsage` 显示 4.8，才能完成端到端确认。

## 十四、cc-haha 是怎样接入 Opus 4.8 API 的

### 14.1 它没有获得一个新的“Opus 4.8 专用接口”

cc-haha 并不是下载了 Opus 4.8，也不是把请求改发到一个只属于 Opus 4.8 的新 HTTP URL。

Anthropic Messages API 的基本形态是：

```text
POST /v1/messages
```

不同模型通常共用这个 Messages endpoint。客户端通过请求体中的：

```json
{
  "model": "claude-opus-4-8"
}
```

告诉服务端本次要调用哪个模型。

因此“接入 Opus 4.8 API”更准确的含义是：

> cc-haha 使用既有的 Anthropic Messages API 和认证通道，把请求中的模型 ID、模型能力参数和本地运行时行为更新为 Opus 4.8。

### 14.2 第一层：继续使用 Anthropic SDK 和 Messages API

远端运行时使用 Anthropic SDK：

```ts
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    // ...
  )
  .withResponse()
```

它没有自己实现另一套 Opus 4.8 网络协议。

请求参数中的关键部分是：

```ts
return {
  model: normalizeModelStringForAPI(options.model),
  messages: ...,
  system,
  tools: allTools,
  max_tokens: maxOutputTokens,
  thinking,
  // ...
}
```

真正决定请求模型的是：

```ts
model: normalizeModelStringForAPI(options.model)
```

`normalizeModelStringForAPI()` 只移除 `[1m]` / `[2m]` 这样的 cc-haha 本地后缀：

```ts
export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
```

它不会把 4.8 转回 4.7 或 4.6。

### 14.3 第二层：沿用订阅 OAuth token 进行认证

Claude 订阅用户创建 Anthropic client 时，远端代码使用：

```ts
const clientConfig = {
  apiKey: isClaudeSubscriber ? null : resolveAnthropicClientApiKey(...),
  authToken: isClaudeSubscriber
    ? getClaudeAIOAuthTokens()?.accessToken
    : undefined,
  // ...
}
```

也就是：

```text
Claude Team/Pro/Max 登录
  → OAuth access token
  → Anthropic SDK authToken
  → Messages API
```

这份 OAuth token 证明“是谁在请求”，但不在本地写明“只能使用 4.6”或“永久允许 4.8”。

实际允许哪些模型仍由 Anthropic 服务端根据以下信息决定：

- 账号和 subscription type；
- Team seat 和 organization；
- 模型 rollout / entitlement；
- organization model restrictions；
- 当前额度和 usage credits；
- 请求通道和客户端兼容策略。

所以修改模型 ID 不会凭空增加账号权限。没有 4.8 entitlement 时，服务端仍可拒绝请求。

### 14.4 第三层：加入 Opus 4.8 模型配置

远端新增：

```ts
export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'anthropic.claude-opus-4-8',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
  azureOpenAI: 'claude-opus-4-8',
}
```

并把它注册为：

```ts
opus48: CLAUDE_OPUS_4_8_CONFIG
```

第一方默认 Opus 被改为：

```ts
return getModelStrings().opus48
```

因此第一方 alias 解析链是：

```text
opus
  → getDefaultOpusModel()
  → getModelStrings().opus48
  → CLAUDE_OPUS_4_8_CONFIG.firstParty
  → claude-opus-4-8
```

最终进入 Messages 请求体：

```json
{
  "model": "claude-opus-4-8"
}
```

### 14.5 为什么旧源码不一定只能请求 4.6 或 4.7

旧源码中的 4.6/4.7 通常只是：

- 本地默认值；
- alias 映射；
- 模型选择器项目；
- capability allowlist；
- provider model ID；
- 显示名；
- 请求参数分支。

它们不是一个把客户端二进制永久绑定到 Opus 4.6 的本地模型许可证。

模型实际运行在 Anthropic 服务端。客户端提交的是一个字符串形式的模型 ID：

```text
claude-opus-4-8
```

只要同时满足：

1. Anthropic 服务端已经部署并识别该 ID；
2. 当前账号具有 entitlement；
3. 现有 OAuth/API 认证仍被接受；
4. Messages 请求协议与新模型兼容；
5. 客户端没有在本地拦截或改写该 ID；

旧客户端就有可能请求一个比自身发布时间更新的服务端模型。

这和数据库客户端能够查询服务器中新增加的一张表类似：客户端不必包含表的数据，只要能发送服务器理解的请求。但如果服务器同时改变了认证、字段格式或事务规则，旧客户端就可能失败。

### 14.6 只改 `model` 参数，是否就能使用 4.8

答案需要区分“最小 API 调用”和“完整 Claude Code 体验”。

#### 最小 API 调用

对于一个已经正确使用 Opus 4.7 Messages API 的简单请求：

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "hello"
    }
  ]
}
```

把模型 ID 改成：

```json
{
  "model": "claude-opus-4-8"
}
```

在账号有权限的前提下，**可能已经足以获得一个基础 Opus 4.8 回复**。

Anthropic 官方迁移指南说明，从 Opus 4.7 迁移到 Opus 4.8 没有 breaking API changes。这个事实解释了为什么旧的 4.7 请求结构可以通过修改模型 ID 快速接入 4.8。

#### 从真正的 4.6 请求直接改到 4.8

如果请求仍然使用 Opus 4.6 的旧协议习惯，仅改模型名不一定成功。

例如旧请求可能发送：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

Opus 4.7 及之后的模型不再接受这种 manual extended thinking，应该使用：

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "high"
  }
}
```

其他需要检查的旧行为还包括：

- 非默认 sampling 参数；
- assistant prefill；
- thinking block round-trip；
- context window；
- max output tokens；
- beta headers；
- Structured Outputs；
- Fast mode。

所以“4.6 请求只换成 4.8 ID”可能收到文本，也可能因为旧参数得到 HTTP 400。

### 14.7 cc-haha 实际不只改了一个模型名称

如果 `29b17c80` 只修改：

```text
claude-opus-4-7
→ claude-opus-4-8
```

那么它会更接近本地早期的 4.7 名称补丁。

但远端 4.8 提交实际修改 49 个文件，加入或更新：

- `CLAUDE_OPUS_4_8_CONFIG` / `opus48`；
- alias 和第一方/第三方默认路由；
- canonical model mapping；
- model picker；
- effort、`xhigh`、`max`；
- adaptive thinking；
- 1M context；
- 128K output；
- Structured Outputs；
- provider model mapping；
- cost；
- prompt environment metadata；
- Desktop/Server/CLI 设置；
- 单元测试和 request-shape 测试。

因此准确表述是：

> 更换 `model` 字段是让服务端选择 Opus 4.8 的核心动作；其余修改用于让旧 agent runtime 正确理解、配置和使用这个新模型。

### 14.8 哪些能力由服务端决定，哪些由 cc-haha 决定

| 层 | 决定方 | 作用 |
| --- | --- | --- |
| 模型是否存在 | Anthropic 服务端 | 是否认识 `claude-opus-4-8` |
| 账号是否可用 | Anthropic 服务端 | Team/seat/org entitlement |
| 最终执行模型 | Anthropic 服务端 | 接受、拒绝、fallback 或 remap |
| 请求的模型 ID | cc-haha | `model: claude-opus-4-8` |
| Thinking/effort 参数 | cc-haha | 请求是否符合 4.8 协议 |
| Context 和输出预算 | cc-haha | 本地 compact、token budget 和 `max_tokens` |
| 工具和 system prompt | cc-haha | Claude Code agent harness 行为 |
| Model picker / 显示名 | cc-haha | 用户能否选择和识别 4.8 |

这也是为什么：

- 改模型 ID 可以调用到新模型；
- 改模型 ID不能授予账号权限；
- 调用成功不等于完整复制了新版 Claude Code。

### 14.9 端到端调用链

远端第一方订阅场景可以概括为：

```text
用户选择 opus / claude-opus-4-8
  ↓
parseUserSpecifiedModel()
  ↓
getDefaultOpusModel() / 精确 ID 透传
  ↓
options.model = claude-opus-4-8
  ↓
构造 system、messages、tools、thinking、effort、max_tokens
  ↓
normalizeModelStringForAPI()
  ↓
Anthropic SDK beta.messages.create()
  ↓
OAuth access token 认证
  ↓
Anthropic Messages API
  ↓
服务端检查 entitlement、请求兼容性和额度
  ↓
Opus 4.8 响应，或者错误/fallback
```

### 14.10 最终回答

“只把请求中的模型名称改成 Opus 4.8，就可以使用 Opus 4.8 吗？”

最准确的回答是：

1. **在服务端模型选择层面，是的。** Messages API 通过 `model` 字段选择模型，改成 `claude-opus-4-8` 后，请求的就是 4.8，不再是 4.6/4.7。
2. **在账号权限层面，不一定。** 服务端必须给当前 Team/seat/org 开放 4.8。
3. **在基础 4.7→4.8 API 兼容层面，通常可以。** 官方说明该迁移没有 breaking API changes。
4. **在完整 agent runtime 层面，不够。** Thinking、effort、context、output、Fast、tools 和 prompt 仍需适配。
5. **cc-haha 远端的做法并非只改一个参数。** `model` 字段是核心，但它同时进行了 49 个文件的运行时适配；前文审计的 Fast、Advisor 和部分 thinking 路径仍是未完成部分。

因此，cc-haha 能够请求 Opus 4.8 的根本原因不是它在本地“拥有”4.8，而是：

> 它保留了可用的 Anthropic 认证和 Messages API 客户端，把服务端模型选择参数改成了 `claude-opus-4-8`，同时补上了多数 4.8 能力判断；最终是否真正执行 4.8，仍由 Anthropic 服务端授权并由响应 `message.model` / `modelUsage` 证明。
