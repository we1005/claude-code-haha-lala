import Ajv from 'ajv'
import {
  findNodeAtLocation,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser'

const COMPACT_PREFIX =
  'This session is being continued from a previous conversation that ran out of context.'

const EXPECTED_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and fixes',
  'Problem Solving',
  'All user messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
]

const compactSummarySchema = {
  type: 'object',
  required: [
    'parentUuid',
    'isSidechain',
    'type',
    'message',
    'isCompactSummary',
    'uuid',
    'timestamp',
    'sessionId',
  ],
  properties: {
    parentUuid: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    isSidechain: { type: 'boolean' },
    type: { const: 'user' },
    message: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: { const: 'user' },
        content: { type: 'string' },
      },
      additionalProperties: true,
    },
    isCompactSummary: { const: true },
    isVisibleInTranscriptOnly: { type: 'boolean' },
    uuid: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validateCompactSummary = ajv.compile(compactSummarySchema)

export class JsonlInputError extends Error {
  constructor(message, diagnostics = []) {
    super(message)
    this.name = 'JsonlInputError'
    this.diagnostics = diagnostics
  }
}

function diagnostic(gate, severity, code, message, location) {
  return { gate, severity, code, message, location }
}

export function normalizeSingleRecordInput(input) {
  const withoutBom = input.startsWith('\uFEFF') ? input.slice(1) : input
  const lines = withoutBom.split(/\r?\n/)

  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()

  if (lines.length !== 1) {
    throw new JsonlInputError('输入必须恰好包含一条物理 JSONL 记录', [
      diagnostic(
        'record',
        'error',
        'record.multiple-lines',
        `检测到 ${lines.length} 条物理行；请粘贴一条完整 JSON 记录`,
      ),
    ])
  }

  const line = lines[0]
  if (!line.trim()) {
    throw new JsonlInputError('JSONL 记录为空', [
      diagnostic('record', 'error', 'record.empty', 'JSONL 记录不能为空'),
    ])
  }
  return line
}

export function parseCompactSummaryLine(input) {
  const rawLine = normalizeSingleRecordInput(input)
  const parseErrors = []
  const tree = parseTree(rawLine, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  })

  if (!tree || parseErrors.length > 0) {
    const diagnostics = parseErrors.map(error =>
      diagnostic(
        'record',
        'error',
        `json.${printParseErrorCode(error.error)}`,
        `JSON 语法错误：${printParseErrorCode(error.error)}`,
        { start: error.offset, end: error.offset + error.length },
      ),
    )
    throw new JsonlInputError('无法解析 JSON 记录', diagnostics)
  }

  let record
  try {
    record = JSON.parse(rawLine)
  } catch (error) {
    throw new JsonlInputError('无法解析 JSON 记录', [
      diagnostic(
        'record',
        'error',
        'json.parse-failed',
        error instanceof Error ? error.message : String(error),
      ),
    ])
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new JsonlInputError('JSONL 记录必须是对象', [
      diagnostic(
        'record',
        'error',
        'record.not-object',
        '顶层 JSON 值必须是 object',
      ),
    ])
  }

  const contentNode = findNodeAtLocation(tree, ['message', 'content'])
  if (!contentNode || contentNode.type !== 'string') {
    throw new JsonlInputError('未找到字符串类型的 message.content', [
      diagnostic(
        'record',
        'error',
        'record.content-not-string',
        '/message/content 必须存在且类型为 string',
      ),
    ])
  }

  const content = record.message?.content
  if (typeof content !== 'string') {
    throw new JsonlInputError('message.content 不是字符串')
  }

  return {
    rawLine,
    tree,
    contentNode,
    record,
    content,
  }
}

export function validateContent(draftContent, originalContent = '', strict = false) {
  const diagnostics = []
  if (typeof draftContent !== 'string') {
    return [
      diagnostic(
        'content',
        'error',
        'content.not-string',
        'Content 必须是字符串',
      ),
    ]
  }

  if (draftContent.length === 0) {
    diagnostics.push(
      diagnostic('content', 'error', 'content.empty', 'Content 不能为空'),
    )
  }

  const invalidControl = [...draftContent].find(char => {
    const code = char.codePointAt(0)
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d
  })
  if (invalidControl) {
    diagnostics.push(
      diagnostic(
        'content',
        'error',
        'content.control-character',
        `包含不允许的控制字符 U+${invalidControl
          .codePointAt(0)
          .toString(16)
          .padStart(4, '0')
          .toUpperCase()}`,
      ),
    )
  }

  const conventionSeverity = strict ? 'error' : 'warning'
  if (!draftContent.startsWith(COMPACT_PREFIX)) {
    diagnostics.push(
      diagnostic(
        'content',
        conventionSeverity,
        'content.prefix-missing',
        '缺少 Claude Code Compact 续接前缀',
      ),
    )
  }
  if (!/(^|\n)Summary:\s*(\n|$)/.test(draftContent)) {
    diagnostics.push(
      diagnostic(
        'content',
        conventionSeverity,
        'content.summary-heading-missing',
        '缺少独立的 Summary: 标题',
      ),
    )
  }

  const locatedSections = []
  for (const match of draftContent.matchAll(/^\s*([1-9])\.\s+([^:\n]+):/gm)) {
    locatedSections.push({ number: Number(match[1]), title: match[2].trim() })
  }
  EXPECTED_SECTIONS.forEach((title, index) => {
    const expectedNumber = index + 1
    const section = locatedSections.find(item => item.number === expectedNumber)
    if (!section) {
      diagnostics.push(
        diagnostic(
          'content',
          conventionSeverity,
          `content.section-${expectedNumber}-missing`,
          `缺少第 ${expectedNumber} 节：${title}`,
        ),
      )
    } else if (section.title.toLowerCase() !== title.toLowerCase()) {
      diagnostics.push(
        diagnostic(
          'content',
          'warning',
          `content.section-${expectedNumber}-renamed`,
          `第 ${expectedNumber} 节标题为“${section.title}”，标准标题为“${title}”`,
        ),
      )
    }
  })

  const fenceCount = (draftContent.match(/```/g) ?? []).length
  if (fenceCount % 2 !== 0) {
    diagnostics.push(
      diagnostic(
        'content',
        conventionSeverity,
        'content.unbalanced-fences',
        `Markdown code fence 数量为 ${fenceCount}，未成对闭合`,
      ),
    )
  }

  if (
    originalContent.length > 0 &&
    draftContent.length < originalContent.length * 0.65
  ) {
    diagnostics.push(
      diagnostic(
        'content',
        'warning',
        'content.large-deletion',
        `Content 长度减少 ${Math.round(
          (1 - draftContent.length / originalContent.length) * 100,
        )}%`,
      ),
    )
  }

  const originalPath = extractTranscriptPath(originalContent)
  const draftPath = extractTranscriptPath(draftContent)
  if (originalPath && originalPath !== draftPath) {
    diagnostics.push(
      diagnostic(
        'content',
        'warning',
        'content.transcript-path-changed',
        draftPath
          ? 'Transcript 路径已发生变化'
          : '原有 Transcript 路径提示已被删除',
      ),
    )
  }

  if (draftContent.length > 2_000_000) {
    diagnostics.push(
      diagnostic(
        'content',
        'error',
        'content.too-large',
        'Content 超过 2,000,000 字符限制',
      ),
    )
  }

  return diagnostics
}

export function validateRecord(record) {
  const diagnostics = []
  const valid = validateCompactSummary(record)
  if (!valid) {
    for (const error of validateCompactSummary.errors ?? []) {
      diagnostics.push(
        diagnostic(
          'record',
          'error',
          `schema.${error.keyword}`,
          `${error.instancePath || '/'} ${error.message ?? '不符合 Schema'}`,
        ),
      )
    }
  }

  if (record.isVisibleInTranscriptOnly !== true) {
    diagnostics.push(
      diagnostic(
        'record',
        'warning',
        'record.transcript-only-flag',
        '本记录未设置 isVisibleInTranscriptOnly: true',
      ),
    )
  }

  if (!isUuid(record.uuid)) {
    diagnostics.push(
      diagnostic('record', 'error', 'record.uuid-invalid', 'uuid 格式无效'),
    )
  }
  if (record.parentUuid !== null && !isUuid(record.parentUuid)) {
    diagnostics.push(
      diagnostic(
        'record',
        'error',
        'record.parent-uuid-invalid',
        'parentUuid 格式无效',
      ),
    )
  }
  if (Number.isNaN(Date.parse(record.timestamp))) {
    diagnostics.push(
      diagnostic(
        'record',
        'error',
        'record.timestamp-invalid',
        'timestamp 不是有效日期',
      ),
    )
  }
  return diagnostics
}

export function buildPatchedLine(snapshot, draftContent, strict = false) {
  const contentDiagnostics = validateContent(
    draftContent,
    snapshot.content,
    strict,
  )
  const recordDiagnostics = validateRecord(snapshot.record)
  const replacement = JSON.stringify(draftContent)
  const { rawLine, contentNode } = snapshot
  const outputLine =
    rawLine.slice(0, contentNode.offset) +
    replacement +
    rawLine.slice(contentNode.offset + contentNode.length)

  const jsonlDiagnostics = []
  let reparsed = null

  if (outputLine.includes('\n') || outputLine.includes('\r')) {
    jsonlDiagnostics.push(
      diagnostic(
        'jsonl',
        'error',
        'jsonl.physical-newline',
        '最终输出包含真实换行，不是一条物理 JSONL 记录',
      ),
    )
  }

  try {
    reparsed = JSON.parse(outputLine)
  } catch (error) {
    jsonlDiagnostics.push(
      diagnostic(
        'jsonl',
        'error',
        'jsonl.parse-failed',
        error instanceof Error ? error.message : String(error),
      ),
    )
  }

  if (reparsed) {
    if (reparsed.message?.content !== draftContent) {
      jsonlDiagnostics.push(
        diagnostic(
          'jsonl',
          'error',
          'jsonl.content-roundtrip-failed',
          '重新解析后的 Content 与编辑器内容不一致',
        ),
      )
    }

    if (!equalExceptContent(snapshot.record, reparsed)) {
      jsonlDiagnostics.push(
        diagnostic(
          'jsonl',
          'error',
          'jsonl.protected-fields-changed',
          '检测到 /message/content 之外的字段变化',
        ),
      )
    }

    jsonlDiagnostics.push(...validateRecord(reparsed).map(item => ({ ...item, gate: 'jsonl' })))
  }

  if (!rawLine.startsWith('{"parentUuid":')) {
    jsonlDiagnostics.push(
      diagnostic(
        'jsonl',
        'warning',
        'jsonl.parent-not-first',
        '记录未以 parentUuid 作为第一个键；语义合法，但不符合当前快速扫描约定',
      ),
    )
  }

  if (jsonlDiagnostics.every(item => item.severity !== 'error')) {
    jsonlDiagnostics.unshift(
      diagnostic(
        'jsonl',
        'info',
        'jsonl.roundtrip-passed',
        '单行解析、Content round-trip 和受保护字段检查均通过',
      ),
    )
  }

  const diagnostics = [
    ...contentDiagnostics,
    ...recordDiagnostics,
    ...jsonlDiagnostics,
  ]
  return {
    outputLine,
    reparsed,
    diagnostics,
    valid: diagnostics.every(item => item.severity !== 'error'),
    audit: {
      onlyContentChanged: reparsed
        ? equalExceptContent(snapshot.record, reparsed)
        : false,
      outputLines: outputLine.split(/\r?\n/).length,
      originalCharacters: snapshot.content.length,
      draftCharacters: draftContent.length,
      deltaCharacters: draftContent.length - snapshot.content.length,
      originalBytes: new TextEncoder().encode(rawLine).length,
      outputBytes: new TextEncoder().encode(outputLine).length,
    },
  }
}

export function summarizeRecord(snapshot) {
  const record = snapshot.record
  return {
    uuid: record.uuid ?? '—',
    parentUuid: record.parentUuid ?? 'null',
    timestamp: record.timestamp ?? '—',
    sessionId: record.sessionId ?? '—',
    role: record.message?.role ?? '—',
    type: record.type ?? '—',
    characters: snapshot.content.length,
    lines: snapshot.content.split('\n').length,
    bytes: new TextEncoder().encode(snapshot.rawLine).length,
  }
}

export function extractTranscriptPath(content) {
  const match = content.match(
    /read the full transcript at:\s*([^\r\n]+)\s*$/m,
  )
  return match?.[1]?.trim() ?? null
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

function equalExceptContent(original, candidate) {
  return deepEqual(maskContent(original), maskContent(candidate))
}

function maskContent(value) {
  const clone = structuredClone(value)
  if (clone?.message && typeof clone.message === 'object') {
    clone.message.content = '__JSONL_SUMMARY_LAB_CONTENT__'
  }
  return clone
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (typeof left !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    )
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqual(left[key], right[key]),
    )
  )
}

export const compactSummaryConvention = {
  prefix: COMPACT_PREFIX,
  sections: EXPECTED_SECTIONS,
}
