import { expect, test } from "bun:test"
import { boardRows, questBoard, questLane, sortNewestFirst, summarizeBoard } from "../quest/board"
import { newQuest } from "../quest/schema"
import type { Quest } from "../quest/types"

function q(id: string, title: string, state: Quest["state"], extra: Partial<Quest> = {}): Quest {
  return { ...newQuest({ id, title, objective: title, createdAt: extra.createdAt ?? `2026-08-28T00:00:0${id.slice(-1)}Z` }), state, ...extra }
}

test("quest lanes map lifecycle without collapsing finished work", () => {
  expect(questLane(q("01j00000000000000000000000", "wait", "Waiting"))).toBe("unassigned")
  expect(questLane(q("01j00000000000000000000001", "owned", "Waiting", { owner: "ses_a" }))).toBe("assigned")
  expect(questLane(q("01j00000000000000000000002", "work", "Working"))).toBe("assigned")
  expect(questLane(q("01j00000000000000000000003", "attn", "Needs attention"))).toBe("attention")
  expect(questLane(q("01j00000000000000000000004", "ver", "Verifying"))).toBe("verifying")
  expect(questLane(q("01j00000000000000000000005", "ready", "Ready to complete"))).toBe("ready")
  expect(questLane(q("01j00000000000000000000006", "done", "Complete"))).toBe("ready")
  expect(questLane(q("01j00000000000000000000007", "old", "Archived"))).toBe("archived")
})

test("board sorts newest first inside each lane and omits empty headers", () => {
  const quests = [
    q("01j00000000000000000000000", "older wait", "Waiting", { createdAt: "2026-08-28T00:00:00.000Z" }),
    q("01j00000000000000000000001", "newer wait", "Waiting", { createdAt: "2026-08-28T00:00:02.000Z" }),
    q("01j00000000000000000000002", "ready", "Complete", { createdAt: "2026-08-28T00:00:01.000Z" }),
    q("01j00000000000000000000003", "archived", "Archived", { createdAt: "2026-08-28T00:00:03.000Z" }),
  ]
  expect(sortNewestFirst(quests).map((item) => item.title)).toEqual(["archived", "newer wait", "ready", "older wait"])
  const lanes = questBoard(quests)
  expect(lanes.unassigned.map((item) => item.title)).toEqual(["newer wait", "older wait"])
  expect(lanes.ready.map((item) => item.title)).toEqual(["ready"])
  const rows = boardRows(quests)
  expect(rows.filter((row) => row.kind === "header").map((row) => row.label)).toEqual(["Unassigned", "Ready to turn in"])
  expect(boardRows(quests, { includeArchived: true }).some((row) => row.kind === "header" && row.lane === "archived")).toBe(true)
  expect(summarizeBoard(quests).counts).toMatchObject({ unassigned: 2, ready: 1, archived: 1 })
})

test("compact board budgets preserve every non-empty lane", () => {
  const quests = [
    ...Array.from({ length: 8 }, (_, i) => q(`01j000000000000000000001${i}`, `assigned ${i}`, "Working")),
    q("01j00000000000000000000200", "attention", "Needs attention"),
    q("01j00000000000000000000201", "ready", "Ready to complete"),
  ]
  const summary = summarizeBoard(quests, undefined, false, 5)
  expect(summary.truncated).toBe(5)
  expect(summary.board.attention).toHaveLength(1)
  expect(summary.board.assigned.length).toBeGreaterThan(0)
  expect(summary.board.ready).toHaveLength(1)
})
