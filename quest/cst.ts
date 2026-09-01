import { digest } from "./privacy"
import { validateQuest } from "./schema"
import type { ParsedQuest, Quest } from "./types"

const KNOWN = ["schema","id","revision","lifecycleEpoch","createdAt","updatedAt","title","objective","kind","priority","state","reason","nextAction","executingCount","executionChangedAt","owner","integrationOwner","requestFingerprint","scope","relationships","deliverables","acceptanceCriteria","usageInstructions","stages","setbacks","sessions","claims","evidence","unresolvedWork","completionPolicy","missingRequirements","notificationCursor","migration","eventCursors","appliedEventIDs","history","abandoned","extensions"] as const
const known = new Set<string>(KNOWN)

/** JSON scalar/object values on YAML mapping lines: a deliberately strict YAML JSON-subset. */
export function parseQuestMarkdown(raw: string): ParsedQuest {
  const match = /^(?:\uFEFF)?---(\r?\n)([\s\S]*?)\1---(?:\1|$)/.exec(raw)
  if (!match) return { body: raw, rawFrontmatter: "", raw, readonly: true, errors: ["missing or malformed frontmatter"], humanHash: digest(raw) }
  const front = match[2], body = raw.slice(match[0].length), value: Record<string, unknown> = {}, errors: string[] = []
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!field) { errors.push(`unsupported frontmatter line: ${line.slice(0, 80)}`); continue }
    if (!known.has(field[1])) continue // preserve unknown/namespaced CST nodes, but never interpret them
    try { value[field[1]] = JSON.parse(field[2]) } catch { errors.push(`invalid JSON value for ${field[1]}`) }
  }
  // v1 fields added after launch are additive. Materialize their empty shape
  // when reading an older snapshot so the existing ledger remains writable.
  if (!Array.isArray(value.usageInstructions)) value.usageInstructions = []
  if (!Array.isArray(value.stages)) value.stages = []
  if (!Array.isArray(value.setbacks)) value.setbacks = []
  errors.push(...validateQuest(value))
  const readonly = errors.length > 0
  return { quest: value as Quest, body, rawFrontmatter: front, raw, readonly, errors, humanHash: humanHash(front, body) }
}

function humanHash(front: string, body: string): string {
  const humanFront = front.split(/\r?\n/).filter((line) => {
    const key = /^([A-Za-z][A-Za-z0-9]*):/.exec(line)?.[1]
    return !key || !known.has(key) || key === "extensions"
  }).join("\n")
  return digest(`${humanFront}\0${body}`)
}

export function serializeQuestMarkdown(quest: Quest, body = "", prior?: ParsedQuest): string {
  const eol = prior?.raw.includes("\r\n") ? "\r\n" : "\n"
  let lines = prior ? prior.rawFrontmatter.split(/\r?\n/) : []
  const emitted = new Set<string>()
  lines = lines.map((line) => {
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!field || !known.has(field[1])) return line
    const key = field[1] as keyof Quest
    emitted.add(key)
    const value = quest[key]
    return value === undefined ? `# removed ${key}` : `${key}: ${JSON.stringify(value)}`
  })
  for (const key of KNOWN) if (!emitted.has(key) && quest[key as keyof Quest] !== undefined) lines.push(`${key}: ${JSON.stringify(quest[key as keyof Quest])}`)
  const front = lines.join(eol).replace(new RegExp(`${eol}+$`), "")
  return `---${eol}${front}${eol}---${eol}${body}`
}

export function assertHumanContentUnchanged(before: ParsedQuest, afterRaw: string): void {
  const after = parseQuestMarkdown(afterRaw)
  if (before.humanHash !== after.humanHash) throw new Error("concurrent human content conflict")
}
