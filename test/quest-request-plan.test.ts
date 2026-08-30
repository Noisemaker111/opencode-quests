import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acceptanceFromRequest, deliverablesFromRequest, planFromRequest, subItems } from "../quest/request-plan"
import { QuestStore } from "../quest/store"
import { QuestTracker } from "../quest/tracker"

const LISTED = `Fix the quests plugin end to end:
- mount the chrome in the session sidebar next to Subagents
- stop the fabricated screenshot test
- add a real slot-name guard
Take a screenshot after and make sure the tests pass.`

test("a checklist request becomes deliverables, one per item", () => {
  const deliverables = deliverablesFromRequest(LISTED)
  expect(deliverables.map((d) => d.title)).toEqual([
    "mount the chrome in the session sidebar next to Subagents",
    "stop the fabricated screenshot test",
    "add a real slot-name guard",
  ])
  expect(deliverables.every((d) => d.status === "pending")).toBe(true)
})

test("verification language becomes acceptance criteria", () => {
  const criteria = acceptanceFromRequest(LISTED)
  expect(criteria.map((c) => c.text)).toContain("Take a screenshot after and make sure the tests pass.")
  expect(criteria.every((c) => c.satisfied === false)).toBe(true)
})

test("an item is work or proof, never counted as both", () => {
  // "stop the fabricated screenshot test" says screenshot and test but is an
  // action, so it must not also appear as something to verify.
  const { deliverables, acceptanceCriteria } = planFromRequest(LISTED)
  const titles = new Set(deliverables.map((d) => d.title))
  for (const criterion of acceptanceCriteria) expect(titles.has(criterion.text)).toBe(false)
})

test("prose without a list still yields the stated work and proof", () => {
  const plan = planFromRequest("Please add explicit context limits to grok-sub so it stops compacting at 200k. Verify with the config test.")
  expect(plan.deliverables).toHaveLength(1)
  expect(plan.deliverables[0].title).toContain("add explicit context limits")
  expect(plan.acceptanceCriteria).toHaveLength(1)
  expect(plan.acceptanceCriteria[0].text).toContain("Verify with the config test")
})

test("work is derived, never invented", () => {
  const plan = planFromRequest("What does the quest board look like right now?")
  expect(plan.deliverables).toEqual([])
  expect(plan.acceptanceCriteria).toEqual([])
})

test("ids are stable and unique so repeated phrasing cannot collide", () => {
  const plan = planFromRequest("- fix the thing\n- fix the thing\n- fix the other thing")
  const ids = plan.deliverables.map((d) => d.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test("sub-items are only read from real list syntax", () => {
  expect(subItems("no list here at all")).toEqual([])
  expect(subItems("1. first\n2) second\n- third")).toEqual(["first", "second", "third"])
})

test("an explicitly created Quest can be born with its planned work", () => {
  // The board had half its Quests at deliverables: [] because admission only
  // ever stored a title and objective.
  const root = mkdtempSync(join(tmpdir(), "quest-plan-"))
  try {
    const tracker = new QuestTracker(new QuestStore(root))
    const plan = planFromRequest(LISTED)
    const quest = tracker.admit({ title: "Fix the quests plugin", objective: LISTED, request: LISTED, ...plan })
    expect(quest.title).toContain("Fix the quests plugin")
    expect(quest.objective).toBe(LISTED)
    expect(quest.deliverables.length).toBe(3)
    expect(quest.acceptanceCriteria.length).toBeGreaterThan(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
