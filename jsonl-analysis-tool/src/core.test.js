import { describe, expect, test } from 'bun:test'
import {
  JsonlInputError,
  buildPatchedLine,
  normalizeSingleRecordInput,
  parseCompactSummaryLine,
  validateContent,
} from './core.js'

const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request and Intent:
   Keep the task moving.
2. Key Technical Concepts:
   - JSONL
3. Files and Code Sections:
   - app.js
4. Errors and fixes:
   - None
5. Problem Solving:
   - Parsed one line
6. All user messages:
   - Build the tool
7. Pending Tasks:
   - Verify output
8. Current Work:
   - Editing content
9. Optional Next Step:
   - Run tests

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/session.jsonl`

function makeLine(content = summary) {
  return JSON.stringify({
    parentUuid: '704061cc-28fc-46d6-9b7c-8c275a4c3631',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: 'fae4fc60-07c2-4845-b557-e5afbc7dff4d',
    timestamp: '2026-08-01T13:08:41.878Z',
    sessionId: '7d14919c-8e0e-4d63-b263-dad4bc0ab5d0',
  })
}

describe('single record parsing', () => {
  test('decodes JSON escapes into a multiline content string', () => {
    const line = makeLine('first line\n"quoted"\\path')
    const snapshot = parseCompactSummaryLine(line)

    expect(snapshot.content).toBe('first line\n"quoted"\\path')
    expect(snapshot.content.split('\n')).toHaveLength(2)
  })

  test('accepts surrounding blank lines but rejects multiple records', () => {
    const line = makeLine()
    expect(normalizeSingleRecordInput(`\n${line}\n`)).toBe(line)
    expect(() => normalizeSingleRecordInput(`${line}\n${line}`)).toThrow(
      JsonlInputError,
    )
  })

  test('rejects malformed JSON and non-string content', () => {
    expect(() => parseCompactSummaryLine('{"broken":')).toThrow(JsonlInputError)
    expect(() =>
      parseCompactSummaryLine(
        JSON.stringify({ message: { role: 'user', content: [] } }),
      ),
    ).toThrow(JsonlInputError)
  })
})

describe('content patching', () => {
  test('changes only the content source range and passes round-trip checks', () => {
    const snapshot = parseCompactSummaryLine(makeLine())
    const draft = `${summary}\nOne more verified detail.`
    const result = buildPatchedLine(snapshot, draft)
    const prefix = snapshot.rawLine.slice(0, snapshot.contentNode.offset)
    const suffix = snapshot.rawLine.slice(
      snapshot.contentNode.offset + snapshot.contentNode.length,
    )

    expect(result.valid).toBe(true)
    expect(result.outputLine.startsWith(prefix)).toBe(true)
    expect(result.outputLine.endsWith(suffix)).toBe(true)
    expect(result.outputLine.includes('\n')).toBe(false)
    expect(JSON.parse(result.outputLine).message.content).toBe(draft)
    expect(result.audit.onlyContentChanged).toBe(true)
    expect(result.audit.outputLines).toBe(1)
  })

  test('reports convention drift without making valid JSON unusable', () => {
    const snapshot = parseCompactSummaryLine(makeLine())
    const result = buildPatchedLine(snapshot, 'A short but legal JSON string')

    expect(result.valid).toBe(true)
    expect(
      result.diagnostics.some(item => item.code === 'content.prefix-missing'),
    ).toBe(true)
    expect(JSON.parse(result.outputLine).message.content).toBe(
      'A short but legal JSON string',
    )
  })

  test('strict mode promotes missing Compact structure to errors', () => {
    const diagnostics = validateContent('plain text', summary, true)
    expect(diagnostics.some(item => item.severity === 'error')).toBe(true)
  })
})
