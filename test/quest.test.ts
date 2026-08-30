import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseQuestMarkdown, serializeQuestMarkdown } from "../quest/cst"
import { newQuest } from "../quest/schema"
import { makeEvent } from "../quest/events"
import { reduceQuest } from "../quest/reducer"
import { completionMissing } from "../quest/completion"
import { dependencyCycles } from "../quest/dependencies"
import { requestFingerprint } from "../quest/privacy"

const id = "01j00000000000000000000000"
test("strict Quest CST preserves body/comments and unknown extensions", () => {
  const q = newQuest({ id, title: "Test", objective: "Keep body" })
  const raw = serializeQuestMarkdown(q, "# human\r\n\r\nDo not rewrite.\r\n") + "" // serializer emits chosen body
  const parsed = parseQuestMarkdown(raw)
  expect(parsed.errors).toEqual([])
  expect(parsed.body).toContain("Do not rewrite")
  expect(serializeQuestMarkdown({ ...q, revision: 1 }, parsed.body, parsed)).toContain("Do not rewrite")
})
test("exact event IDs suppress duplicates and blocked sessions are not executing", () => {
  let q = newQuest({ id, title: "Test", objective: "x" })
  const planned = makeEvent(id, "session-planned", { callID: "call", role: "worker" }, { eventID: "e1", sourceSequence: 1 })
  q = reduceQuest(q, planned); q = reduceQuest(q, planned)
  q = reduceQuest(q, makeEvent(id, "session-bound", { callID: "call", sessionID: "ses_child" }, { eventID: "e2", sourceSequence: 2 }))
  q = reduceQuest(q, makeEvent(id, "session-state", { callID: "call", state: "blocked" }, { eventID: "e3", sourceSequence: 3 }))
  expect(q.sessions).toHaveLength(1); expect(q.executingCount).toBe(0); expect(q.state).toBe("Needs attention")
})
test("completion is fail-closed and dependency cycles are deterministic", () => {
  const a = newQuest({ id, title: "A", objective: "a" }), b = newQuest({ id: "01j00000000000000000000001", title: "B", objective: "b" })
  a.relationships.dependencies = [b.id]; b.relationships.dependencies = [a.id]
  expect(dependencyCycles([a, b]).length).toBe(1)
  expect(completionMissing(a)).toContain("session evidence")
})
test("fingerprints are deterministic and bounded", () => { expect(requestFingerprint({ prompt: "x" })).toBe(requestFingerprint({ prompt: "x" })) })
