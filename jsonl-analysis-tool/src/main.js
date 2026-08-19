import {
  Braces,
  CheckCircle2,
  CircleX,
  ClipboardPaste,
  Copy,
  Download,
  FileJson2,
  FlaskConical,
  FolderOpen,
  Info,
  LoaderCircle,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  ShieldEllipsis,
  TriangleAlert,
  createIcons,
} from 'lucide'
import {
  JsonlInputError,
  buildPatchedLine,
  parseCompactSummaryLine,
  summarizeRecord,
} from './core.js'
import './styles.css'

const iconSet = {
  Braces,
  CheckCircle2,
  CircleX,
  ClipboardPaste,
  Copy,
  Download,
  FileJson2,
  FlaskConical,
  FolderOpen,
  Info,
  LoaderCircle,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  ShieldEllipsis,
  TriangleAlert,
}

const elements = {
  headerStatus: document.querySelector('#header-status'),
  rawInput: document.querySelector('#raw-input'),
  rawCounter: document.querySelector('#raw-counter'),
  parseButton: document.querySelector('#parse-button'),
  pasteButton: document.querySelector('#paste-button'),
  fileButton: document.querySelector('#file-button'),
  fileInput: document.querySelector('#file-input'),
  sampleButton: document.querySelector('#sample-button'),
  resetButton: document.querySelector('#reset-button'),
  fileScan: document.querySelector('#file-scan'),
  scanLabel: document.querySelector('#scan-label'),
  scanCount: document.querySelector('#scan-count'),
  scanProgress: document.querySelector('#scan-progress'),
  summarySelect: document.querySelector('#summary-select'),
  contentEditor: document.querySelector('#content-editor'),
  contentCounter: document.querySelector('#content-counter'),
  changeCounter: document.querySelector('#change-counter'),
  strictToggle: document.querySelector('#strict-toggle'),
  recordMeta: document.querySelector('#record-meta'),
  gateStrip: document.querySelector('#gate-strip'),
  diagnosticList: document.querySelector('#diagnostic-list'),
  validationTotal: document.querySelector('#validation-total'),
  auditGrid: document.querySelector('#audit-grid'),
  generateButton: document.querySelector('#generate-button'),
  widthSlider: document.querySelector('#width-slider'),
  widthValue: document.querySelector('#width-value'),
  terminalContent: document.querySelector('#terminal-content'),
  previewContent: document.querySelector('#preview-content'),
  outputLine: document.querySelector('#output-line'),
  outputCounter: document.querySelector('#output-counter'),
  outputState: document.querySelector('#output-state'),
  copyButton: document.querySelector('#copy-button'),
  downloadButton: document.querySelector('#download-button'),
  toastRegion: document.querySelector('#toast-region'),
}

const state = {
  snapshot: null,
  latestResult: null,
  activeGate: 'content',
  fingerprint: '—',
  programmaticRawUpdate: false,
  summaries: [],
  refreshTimer: null,
}

const sampleContent = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request and Intent:
   Build a local editor for one Compact Summary JSONL record.

2. Key Technical Concepts:
   - JSONL parsing
   - AST source-range replacement
   - Content round-trip validation

3. Files and Code Sections:
   - jsonl-analysis-tool/src/core.js

4. Errors and fixes:
   - None.

5. Problem Solving:
   - Preserve every field except message.content.

6. All user messages:
   - Create a static web application.

7. Pending Tasks:
   - Review the generated JSONL line.

8. Current Work:
   - Editing the Compact Summary content.

9. Optional Next Step:
   - Copy the validated record.

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/example-session.jsonl`

const sampleLine = JSON.stringify({
  parentUuid: '704061cc-28fc-46d6-9b7c-8c275a4c3631',
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: sampleContent },
  isVisibleInTranscriptOnly: true,
  isCompactSummary: true,
  uuid: 'fae4fc60-07c2-4845-b557-e5afbc7dff4d',
  timestamp: '2026-08-01T13:08:41.878Z',
  sessionId: '7d14919c-8e0e-4d63-b263-dad4bc0ab5d0',
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/tmp/example-project',
  version: '999.0.0-local',
})

function refreshIcons() {
  createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.8 } })
}

function setHeaderStatus(text, status = 'idle', icon = 'shield-check') {
  elements.headerStatus.dataset.state = status
  elements.headerStatus.replaceChildren()
  const iconNode = document.createElement('i')
  iconNode.dataset.lucide = icon
  const label = document.createElement('span')
  label.textContent = text
  elements.headerStatus.append(iconNode, label)
  refreshIcons()
}

function setRawValue(value) {
  state.programmaticRawUpdate = true
  elements.rawInput.value = value
  state.programmaticRawUpdate = false
  updateRawCounter()
}

function updateRawCounter() {
  const bytes = new TextEncoder().encode(elements.rawInput.value).length
  elements.rawCounter.textContent = formatBytes(bytes)
}

function invalidateParsedState() {
  state.snapshot = null
  state.latestResult = null
  state.fingerprint = '—'
  elements.contentEditor.value = ''
  elements.contentEditor.disabled = true
  elements.generateButton.disabled = true
  elements.copyButton.disabled = true
  elements.downloadButton.disabled = true
  elements.outputLine.value = ''
  elements.previewContent.textContent = '等待 Content'
  elements.contentCounter.textContent = '0 字符 · 0 行'
  elements.changeCounter.textContent = 'Δ 0'
  elements.outputCounter.textContent = '0 B · 0 物理行'
  setOutputState('尚未生成', 'idle')
  renderMeta(null)
  renderValidation([], null)
  setHeaderStatus('本地处理')
}

async function parseCurrentRecord() {
  setHeaderStatus('正在解析', 'working', 'loader-circle')
  try {
    const snapshot = parseCompactSummaryLine(elements.rawInput.value)
    state.snapshot = snapshot
    state.fingerprint = await sha256(snapshot.rawLine)
    elements.contentEditor.disabled = false
    elements.contentEditor.value = snapshot.content
    elements.previewContent.textContent = snapshot.content
    renderMeta(summarizeRecord(snapshot))
    refreshDraftValidation()
    setHeaderStatus('记录已解析')
    toast('记录解析成功', 'success')
  } catch (error) {
    const diagnostics =
      error instanceof JsonlInputError && error.diagnostics.length > 0
        ? error.diagnostics
        : [
            {
              gate: 'record',
              severity: 'error',
              code: 'record.parse-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          ]
    invalidateParsedState()
    state.activeGate = 'record'
    renderValidation(diagnostics, null)
    setHeaderStatus('解析失败', 'error', 'circle-x')
    toast('JSONL 记录解析失败', 'error')
  }
}

function refreshDraftValidation() {
  if (!state.snapshot) return
  const draft = elements.contentEditor.value
  state.latestResult = buildPatchedLine(
    state.snapshot,
    draft,
    elements.strictToggle.checked,
  )
  elements.previewContent.textContent = draft || 'Content 为空'
  const lines = draft.length === 0 ? 0 : draft.split('\n').length
  elements.contentCounter.textContent = `${formatNumber(draft.length)} 字符 · ${formatNumber(lines)} 行`
  const delta = state.latestResult.audit.deltaCharacters
  elements.changeCounter.textContent = `Δ ${delta > 0 ? '+' : ''}${formatNumber(delta)}`
  elements.changeCounter.dataset.state = delta === 0 ? 'idle' : 'changed'
  elements.generateButton.disabled = !state.latestResult.valid
  renderValidation(state.latestResult.diagnostics, state.latestResult.audit)
  clearGeneratedOutput()
}

function clearGeneratedOutput() {
  elements.outputLine.value = ''
  elements.copyButton.disabled = true
  elements.downloadButton.disabled = true
  elements.outputCounter.textContent = '0 B · 0 物理行'
  setOutputState('尚未生成', 'idle')
}

function generateOutput() {
  if (!state.snapshot || !state.latestResult) return
  refreshDraftValidation()
  if (!state.latestResult.valid) {
    toast('存在阻断错误，无法生成', 'error')
    return
  }
  const output = state.latestResult.outputLine
  elements.outputLine.value = output
  elements.copyButton.disabled = false
  elements.downloadButton.disabled = false
  elements.outputCounter.textContent = `${formatBytes(
    new TextEncoder().encode(output).length,
  )} · 1 物理行`
  setOutputState('验证通过', 'pass')
  toast('单行 JSONL 已生成', 'success')
}

function renderMeta(meta) {
  const values = meta
    ? [
        ['UUID', meta.uuid],
        ['Role', `${meta.type}/${meta.role}`],
        ['Lines', formatNumber(meta.lines)],
      ]
    : [
        ['UUID', '未解析'],
        ['Role', '—'],
        ['Lines', '0'],
      ]
  elements.recordMeta.replaceChildren(
    ...values.map(([label, value]) => {
      const wrapper = document.createElement('span')
      const strong = document.createElement('strong')
      const code = document.createElement('code')
      strong.textContent = label
      code.textContent = value
      code.title = value
      wrapper.append(strong, code)
      return wrapper
    }),
  )
}

function renderValidation(diagnostics, audit) {
  const errors = diagnostics.filter(item => item.severity === 'error').length
  const warnings = diagnostics.filter(item => item.severity === 'warning').length
  elements.validationTotal.textContent = `${errors} error · ${warnings} warn`

  for (const gate of elements.gateStrip.querySelectorAll('.gate')) {
    const gateName = gate.dataset.gate
    const items = diagnostics.filter(item => item.gate === gateName)
    const gateErrors = items.filter(item => item.severity === 'error').length
    const gateWarnings = items.filter(item => item.severity === 'warning').length
    const status = gateErrors > 0 ? 'error' : gateWarnings > 0 ? 'warning' : 'pass'
    gate.dataset.status = status
    gate.classList.toggle('active', gateName === state.activeGate)
    gate.querySelector('strong').textContent =
      gateErrors > 0 ? gateErrors : gateWarnings > 0 ? gateWarnings : '✓'
  }

  const activeItems = diagnostics.filter(item => item.gate === state.activeGate)
  elements.diagnosticList.replaceChildren()
  if (activeItems.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const icon = document.createElement('i')
    icon.dataset.lucide = diagnostics.length === 0 ? 'shield-ellipsis' : 'check-circle-2'
    const label = document.createElement('span')
    label.textContent = diagnostics.length === 0 ? '等待解析' : '此 Gate 已通过'
    empty.append(icon, label)
    elements.diagnosticList.append(empty)
  } else {
    for (const item of activeItems) {
      elements.diagnosticList.append(createDiagnosticItem(item))
    }
  }

  const auditValues = audit
    ? [
        ['物理行', String(audit.outputLines)],
        ['字段变化', audit.onlyContentChanged ? '仅 Content' : '异常'],
        ['输出大小', formatBytes(audit.outputBytes)],
        ['指纹', state.fingerprint.slice(0, 12)],
      ]
    : [
        ['物理行', '—'],
        ['字段变化', '—'],
        ['输出大小', '—'],
        ['指纹', '—'],
      ]
  elements.auditGrid.replaceChildren(
    ...auditValues.map(([label, value]) => {
      const wrapper = document.createElement('span')
      const small = document.createElement('small')
      const strong = document.createElement('strong')
      small.textContent = label
      strong.textContent = value
      strong.title = value
      wrapper.append(small, strong)
      return wrapper
    }),
  )
  refreshIcons()
}

function createDiagnosticItem(item) {
  const wrapper = document.createElement('div')
  wrapper.className = 'diagnostic-item'
  wrapper.dataset.severity = item.severity
  const icon = document.createElement('i')
  icon.dataset.lucide =
    item.severity === 'error'
      ? 'circle-x'
      : item.severity === 'warning'
        ? 'triangle-alert'
        : 'info'
  const body = document.createElement('div')
  const code = document.createElement('strong')
  const message = document.createElement('p')
  code.textContent = item.code
  message.textContent = item.message
  body.append(code, message)
  wrapper.append(icon, body)
  return wrapper
}

async function scanFile(file) {
  elements.fileScan.hidden = false
  elements.scanLabel.textContent = file.name
  elements.scanCount.textContent = '扫描中'
  elements.scanProgress.value = 0
  setHeaderStatus('扫描 JSONL', 'working', 'loader-circle')
  elements.fileButton.disabled = true

  try {
    const summaries = []
    const reader = file.stream().getReader()
    const decoder = new TextDecoder()
    let carry = ''
    let processedBytes = 0
    let lineNumber = 0

    const processLine = line => {
      lineNumber += 1
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
      if (!normalized.trim()) return
      try {
        const record = JSON.parse(normalized)
        if (
          record?.isCompactSummary === true &&
          typeof record.message?.content === 'string'
        ) {
          summaries.push({
            lineNumber,
            rawLine: normalized,
            uuid: record.uuid ?? 'unknown',
            timestamp: record.timestamp ?? '',
            preview: firstMeaningfulLine(record.message.content),
          })
        }
      } catch {
        // A malformed non-target line is counted but does not abort discovery.
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      processedBytes += value.byteLength
      carry += decoder.decode(value, { stream: true })
      let newlineIndex
      while ((newlineIndex = carry.indexOf('\n')) !== -1) {
        processLine(carry.slice(0, newlineIndex))
        carry = carry.slice(newlineIndex + 1)
      }
      elements.scanProgress.value = Math.min(
        100,
        Math.round((processedBytes / file.size) * 100),
      )
      elements.scanCount.textContent = `${formatNumber(lineNumber)} 行`
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    carry += decoder.decode()
    if (carry.length > 0) processLine(carry)

    state.summaries = summaries
    renderSummaryOptions(summaries)
    elements.scanProgress.value = 100
    elements.scanCount.textContent = `${summaries.length} 条 Summary`
    if (summaries.length > 0) {
      const latest = summaries.at(-1)
      elements.summarySelect.value = String(summaries.length - 1)
      selectScannedSummary(latest)
      setHeaderStatus('扫描完成')
      toast(`找到 ${summaries.length} 条 Compact Summary`, 'success')
    } else {
      setHeaderStatus('未找到 Summary', 'error', 'circle-x')
      toast('文件中没有 Compact Summary 记录', 'error')
    }
  } catch (error) {
    setHeaderStatus('文件扫描失败', 'error', 'circle-x')
    toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    elements.fileButton.disabled = false
    elements.fileInput.value = ''
  }
}

function renderSummaryOptions(summaries) {
  elements.summarySelect.replaceChildren()
  summaries.forEach((item, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = `L${item.lineNumber} · ${formatTimestamp(item.timestamp)} · ${item.uuid.slice(0, 8)} · ${item.preview}`
    elements.summarySelect.append(option)
  })
  elements.summarySelect.disabled = summaries.length === 0
}

function selectScannedSummary(summary) {
  if (!summary) return
  invalidateParsedState()
  setRawValue(summary.rawLine)
  void parseCurrentRecord()
}

async function copyOutput() {
  if (!elements.outputLine.value) return
  try {
    await navigator.clipboard.writeText(elements.outputLine.value)
    toast('已复制单行 JSONL', 'success')
  } catch {
    elements.outputLine.select()
    document.execCommand('copy')
    toast('已复制单行 JSONL', 'success')
  }
}

function downloadOutput() {
  if (!elements.outputLine.value || !state.snapshot) return
  const blob = new Blob([`${elements.outputLine.value}\n`], {
    type: 'application/x-ndjson;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `compact-summary-${state.snapshot.record.uuid}.jsonl`
  link.click()
  URL.revokeObjectURL(url)
  toast('JSONL 记录已下载', 'success')
}

function setOutputState(text, status) {
  elements.outputState.textContent = text
  elements.outputState.dataset.state = status
}

function toast(message, kind = 'info') {
  const node = document.createElement('div')
  node.className = 'toast'
  const icon = document.createElement('i')
  icon.dataset.lucide =
    kind === 'error' ? 'circle-x' : kind === 'success' ? 'check-circle-2' : 'info'
  const text = document.createElement('span')
  text.textContent = message
  node.append(icon, text)
  elements.toastRegion.append(node)
  refreshIcons()
  window.setTimeout(() => node.remove(), 2600)
}

async function sha256(value) {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function firstMeaningfulLine(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 52) ?? 'Untitled summary'
}

function formatTimestamp(value) {
  if (!value) return 'no timestamp'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

elements.rawInput.addEventListener('input', () => {
  updateRawCounter()
  if (!state.programmaticRawUpdate && state.snapshot) invalidateParsedState()
})
elements.parseButton.addEventListener('click', () => void parseCurrentRecord())
elements.pasteButton.addEventListener('click', async () => {
  try {
    const value = await navigator.clipboard.readText()
    invalidateParsedState()
    setRawValue(value)
    toast('已从剪贴板读取', 'success')
  } catch {
    toast('无法读取剪贴板，请手动粘贴', 'error')
    elements.rawInput.focus()
  }
})
elements.fileButton.addEventListener('click', () => elements.fileInput.click())
elements.fileInput.addEventListener('change', event => {
  const file = event.target.files?.[0]
  if (file) void scanFile(file)
})
elements.sampleButton.addEventListener('click', () => {
  invalidateParsedState()
  setRawValue(sampleLine)
  void parseCurrentRecord()
})
elements.resetButton.addEventListener('click', () => {
  setRawValue('')
  elements.fileScan.hidden = true
  state.summaries = []
  invalidateParsedState()
  elements.rawInput.focus()
})
elements.contentEditor.addEventListener('input', () => {
  window.clearTimeout(state.refreshTimer)
  state.refreshTimer = window.setTimeout(refreshDraftValidation, 90)
})
elements.strictToggle.addEventListener('change', refreshDraftValidation)
elements.generateButton.addEventListener('click', generateOutput)
elements.copyButton.addEventListener('click', () => void copyOutput())
elements.downloadButton.addEventListener('click', downloadOutput)
elements.summarySelect.addEventListener('change', event => {
  selectScannedSummary(state.summaries[Number(event.target.value)])
})
elements.gateStrip.addEventListener('click', event => {
  const gate = event.target.closest('.gate')
  if (!gate) return
  state.activeGate = gate.dataset.gate
  renderValidation(
    state.latestResult?.diagnostics ?? [],
    state.latestResult?.audit ?? null,
  )
})
elements.widthSlider.addEventListener('input', () => {
  const value = elements.widthSlider.value
  elements.widthValue.value = value
  elements.widthValue.textContent = value
  elements.terminalContent.style.setProperty('--terminal-columns', value)
})

refreshIcons()
updateRawCounter()
renderValidation([], null)
