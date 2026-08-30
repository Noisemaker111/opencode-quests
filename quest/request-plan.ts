/**
 * An explicitly created Quest should already carry the work, not just
 * a title. Half the board was being created with `deliverables: []` and
 * `acceptanceCriteria: []` and only filled in later if an agent bothered — so
 * the Quest could not answer "what is left" for the session working it.
 *
 * This derives what the request actually states. It does not invent work: a
 * request with no checklist and no verification language yields none, and the
 * agent is expected to add them as it plans.
 */
import type { AcceptanceCriterion, Deliverable } from "./types"

/** Sub-items under a request: nested bullets, numbered steps, "and then" clauses. */
const SUB_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/

/** Language that means "prove it", which becomes an acceptance criterion. */
const VERIFICATION = /\b(screenshot|screen shot|test|tests|verify|verified|prove|proof|confirm|passes|passing|evidence|benchmark|measure|smoke[- ]test|typecheck|lint)\b/i

/**
 * Language that means "this is a thing to build". Deliberately excludes very
 * generic verbs like "make" — "make sure the tests pass" is proof, not work.
 */
const ACTION = /\b(add|build|create|implement|fix|remove|delete|replace|rename|update|migrate|wire|mount|register|expose|support|stop|extract|refactor|document|move|split|merge|enable|disable)\b/i

const MAX_ITEMS = 20
const MAX_LEN = 200

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= MAX_LEN ? flat : `${flat.slice(0, MAX_LEN - 1).trimEnd()}…`
}

function slug(text: string, index: number): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 5).join("-")
  return base || `item-${index + 1}`
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Sentences, split on terminators but tolerant of the way people actually type. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
}

/** Explicit list items inside one request. Prose without a list yields none. */
export function subItems(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const items: string[] = []
  for (const line of lines) {
    const match = line.match(SUB_ITEM)
    if (match?.[1]) items.push(match[1].trim())
  }
  return items
}

/**
 * One item is either work or proof, never both.
 *
 * Proof is verification language with no action verb — "take a screenshot
 * after", "make sure the tests pass". Everything else that names work is a
 * deliverable, so "stop the fabricated screenshot test" stays work despite
 * saying "screenshot" and "test".
 */
function isAcceptance(item: string): boolean {
  return VERIFICATION.test(item) && !ACTION.test(item)
}

export function deliverablesFromRequest(text: string): Deliverable[] {
  const listed = subItems(text)
  // Someone who wrote a list meant every line as work, so list items only need
  // to not be pure verification. Prose has no such signal, so it falls back to
  // sentences that actually name an action — otherwise a rambling paragraph
  // becomes twelve deliverables.
  const source = listed.length
    ? listed.filter((item) => !isAcceptance(item))
    : sentences(text).filter((s) => ACTION.test(s) && !isAcceptance(s))
  return uniqueBy(
    source.slice(0, MAX_ITEMS).map((item, index) => ({
      id: slug(item, index),
      title: trim(item),
      status: "pending" as const,
    })),
    (d) => d.id,
  )
}

export function acceptanceFromRequest(text: string): AcceptanceCriterion[] {
  // Trailing verification sentences usually sit outside the list ("Take a
  // screenshot after"), so list items and sentences are both considered.
  const source = [...subItems(text), ...sentences(text)].filter(isAcceptance)
  return uniqueBy(
    source.slice(0, MAX_ITEMS).map((item, index) => ({
      id: slug(item, index),
      text: trim(item),
      satisfied: false,
    })),
    (c) => c.id,
  )
}

export type QuestPlan = { deliverables: Deliverable[]; acceptanceCriteria: AcceptanceCriterion[] }

export function planFromRequest(text: string): QuestPlan {
  return { deliverables: deliverablesFromRequest(text), acceptanceCriteria: acceptanceFromRequest(text) }
}
