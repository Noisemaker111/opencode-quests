import { expect, test } from "bun:test"
import { newQuest } from "../quest/schema"
import { renderFrame, questIndicator } from "../quest/tui-model"
import { registerQuestHost } from "../quest/host"
const states = ["Waiting", "Working", "Needs attention", "Verifying", "Ready to complete", "Complete", "Archived"] as const
const qs = states.map((state, i) => ({ ...newQuest({ id: `01j0000000000000000000000${i}`, title: `Q${i}`, objective: "x" }), state }))
const q = qs[0]
test("framebuffer overview/detail are bounded at narrow and wide widths", () => { expect(questIndicator([q])).toBe("1 Quests"); for (const width of [40, 120]) { expect(renderFrame([q], { type: "overview" }, width).lines.every((x) => x.length <= width)).toBe(true); expect(renderFrame([q], { type: "detail", questID: q.id }, width).lines.every((x) => x.length <= width)).toBe(true) } })
test("indicator counts every non-archived lifecycle state, including finished work", () => {
  expect(questIndicator(qs)).toBe("6 Quests")
  const overview = renderFrame(qs, { type: "overview" }, 120)
  expect(overview.lines[0]).toBe("6 Quests")
  expect(overview.lines).toContain("Needs attention")
  expect(overview.lines).toContain("Assigned")
  expect(overview.lines).toContain("Unassigned")
  expect(overview.lines).toContain("Ready to turn in")
  expect(overview.lines.join("\n")).toContain("Ready for you to turn in")
  expect(overview.lines.join("\n")).toContain("Waiting Q0")
  expect(renderFrame([q], { type: "detail", questID: q.id }, 120).lines.join("\n")).toContain("[Accept] [Execute] [Complete] [Turn in]")
})
test("host registration tolerates unavailable APIs and disposes all registrations", () => { const calls: string[] = []; const dispose = registerQuestHost({ slot: (n: string) => { calls.push(n); return () => calls.push("disposed") }, command: (n: string) => { calls.push(n); return () => calls.push("disposed") }, palette: () => () => calls.push("disposed"), width: 80 }, () => [q]); expect(calls).toContain("home-right"); expect(calls).toContain("/quests"); expect(calls).toContain("quest.accept"); expect(calls).toContain("quest.execute"); dispose(); expect(calls.filter((x) => x === "disposed").length).toBe(14); expect(() => registerQuestHost({}, () => [])()).not.toThrow() })
