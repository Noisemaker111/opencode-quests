import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { newQuest } from "../quest/schema"
import { completionMissing } from "../quest/completion"
import { validateQuestCandidate, selectLastKnownGood } from "../quest/candidate"
import { runQuestCommand, QUEST_COMMANDS } from "../quest/commands"
import { QuestStore } from "../quest/store"
import { generateQuestIndex, readAllQuests } from "../quest/index"
import { questLane } from "../quest/board"
import { applyMigration } from "../quest/migration-apply"
test("candidate failures retain last known good", () => { const d = mkdtempSync(join(tmpdir(), "quest-candidate-")); mkdirSync(join(d, "candidate")); writeFileSync(join(d, "candidate", "plugin-set.json"), "{}"); expect(validateQuestCandidate(join(d, "candidate")).ok).toBe(true); const bad = join(d, "bad"); mkdirSync(bad); writeFileSync(join(bad, "plugin-set.json"), "{\"entrypoints\":[\"missing.ts\"]}"); expect(selectLastKnownGood(join(d, "candidate"), bad)).toBe(join(d, "candidate")); rmSync(d, { recursive: true, force: true }) })
test("20 quests retain independent exact identities and completion fails closed", () => { const qs = Array.from({ length: 20 }, (_, i) => newQuest({ id: `01j000000000000000000000${String(i).padStart(2, "0")}`, title: `Q${i}`, objective: "x" })); expect(new Set(qs.map((q) => q.id)).size).toBe(20); expect(completionMissing(qs[0])).toContain("session evidence") })
test("command surface is explicit", () => {
  for (const verb of ["view", "accept", "execute", "complete", "turn-in"]) expect(QUEST_COMMANDS).toContain(verb)
  expect(QUEST_COMMANDS).toContain("mark deliverable")
})
test("accept assigns without fabricating a session and many exact sessions can execute", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-accept-")), id = "01j00000000000000000000000", store = new QuestStore(root)
  store.create({ id, title: "Backlog item", objective: "x" })
  const accepted = runQuestCommand(store, "accept", id, { callID: "accept-1", owner: "ses_owner" })
  expect(accepted.owner).toBe("ses_owner")
  expect(accepted.sessions).toEqual([])
  expect(accepted.state).toBe("Waiting")
  expect(questLane(accepted)).toBe("assigned")
  expect(() => runQuestCommand(store, "execute", id)).toThrow("explicit callID or sessionID")
  const started = runQuestCommand(store, "start-session", id, { sessionID: "ses_one" })
  expect(started.sessions).toHaveLength(1)
  expect(started.sessions[0]).toMatchObject({ callID: "session:ses_one", sessionID: "ses_one", state: "executing" })
  expect(started.state).toBe("Working")
  expect(questLane(started)).toBe("assigned")
  const parallel = runQuestCommand(store, "execute", id, { callID: "exec-2", sessionID: "ses_two" })
  expect(parallel.sessions.map((session) => session.sessionID)).toEqual(["ses_one", "ses_two"])
  rmSync(root, { recursive: true, force: true })
})

test("abandon, archive and reopen replay; delete is confirmed and durable", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-lifecycle-")), id = "01j00000000000000000000000", store = new QuestStore(root)
  store.create({ id, title: "Lifecycle", objective: "x" })
  expect(runQuestCommand(store, "abandon", id).abandoned).toBe(true)
  expect(new QuestStore(root).read(id)?.state).toBe("Archived")
  const reopened = runQuestCommand(store, "reopen", id)
  expect(reopened.state).toBe("Waiting")
  expect(reopened.lifecycleEpoch).toBe(2)
  expect(runQuestCommand(store, "archive", id).state).toBe("Archived")
  expect(() => runQuestCommand(store, "delete", id)).toThrow("confirmed=true")
  const deleted = runQuestCommand(store, "delete", id, { confirmed: true })
  expect(deleted.history.at(-1)?.type).toBe("delete")
  expect(new QuestStore(root).read(id)).toBeUndefined()
  expect(existsSync(join(root, ".opencode", ".quest-runtime", "deleted", `${id}.md`))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test("work completion remains active until explicit user turn-in and survives reload", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-turn-in-")), id = "01j00000000000000000000000", store = new QuestStore(root)
  store.create({ id, title: "Turn in", objective: "x", usageInstructions: ["Use the finished result"], completionPolicy: { requireSessions: false, requireCommits: false, requireTests: false, requireReview: false, requireArtifacts: false, requirePublish: false, requireWorktreeEquality: false } })
  const finished = store.apply(id, "complete", {})
  expect(finished.state).toBe("Complete"); expect(store.read(id)?.state).toBe("Complete")
  const archived = runQuestCommand(store, "turn-in", id)
  expect(archived.state).toBe("Archived"); expect(new QuestStore(root).read(id)?.state).toBe("Archived")
  rmSync(root, { recursive: true, force: true })
})
test("generated Quest log keeps finished work visible with a turn-in action", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-log-")), id = "01j00000000000000000000000", store = new QuestStore(root)
  store.create({ id, title: "Finished log entry", objective: "x", usageInstructions: ["Use the finished result"], completionPolicy: { requireSessions: false, requireCommits: false, requireTests: false, requireReview: false, requireArtifacts: false, requirePublish: false, requireWorktreeEquality: false } })
  store.apply(id, "complete", {})
  const log = generateQuestIndex(root)
  expect(log).toContain("Finished log entry"); expect(log).toContain("Complete (ready for user turn-in)")
  rmSync(root, { recursive: true, force: true })
})
test("legacy ledgers migrate to durable Quests before source removal", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-migration-")), legacy = join(root, ".opencode")
  mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, "TODO.md"), "# TODO\n\n- unfinished migration\n")
  const result = applyMigration(root)
  expect(result).toHaveLength(1); expect(existsSync(join(legacy, "TODO.md"))).toBe(false)
  expect(result[0].questIDs).toHaveLength(1)
  expect(readAllQuests(root).some(({ quest }) => quest?.title.includes("unfinished migration"))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})
test("legacy migration deduplicates rows and recovers from a malformed checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "quest-migration-retry-")), legacy = join(root, ".opencode"), runtime = join(legacy, ".quest-runtime", "migration-backups")
  mkdirSync(runtime, { recursive: true }); writeFileSync(join(legacy, "TODO.md"), "- same claim\n- same claim\n"); writeFileSync(join(runtime, "migration-checkpoint.json"), "not-json")
  const result = applyMigration(root)
  expect(result[0].questIDs).toHaveLength(1); expect(readAllQuests(root).filter(({ quest }) => quest?.title.includes("same claim"))).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})
