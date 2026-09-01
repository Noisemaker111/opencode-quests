import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const src = readFileSync(join(root, "quest", "tui-active", "quests.tsx"), "utf8")
const board = readFileSync(join(root, "quest", "tui-active", "quest-board.tsx"), "utf8")
const code = `${src}\n${board}`.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

test("quests uses beta-18684 slots and a mounted /quests command", () => {
  expect(code).toMatch(/Plugin\.define\s*\(\s*\{[\s\S]*?id:\s*["']quests["']/)
  expect(code).toMatch(/ui\.slot\(\{\s*append:\s*["']app["']/)
  expect(code).toMatch(/ui\.slot\(\{\s*append:\s*["']prompt\.footer["']/)
  expect(code).toMatch(/append:\s*["']sidebar\.content["']/)
  expect(code).toMatch(/keymap\.layer\s*\(/)
  expect(code).toMatch(/slash:\s*\{\s*name:\s*["']quests["']/)
  expect(code).not.toMatch(/slots\.register|keymap\.registerLayer|slashName/)
})

test("quests is a full-screen primary route, not a session-shaped picker dialog", () => {
  expect(code).toMatch(/ui\.router\.register\(\{\s*name:\s*["']quests["']/)
  expect(code).toMatch(/router\.navigate\(\{\s*type:\s*["']plugin["'],\s*id:\s*["']quests["'],\s*name:\s*["']quests["']/)
  expect(code).toMatch(/Symbol\.for\(["']opencode-config\.quests\.primary-route["']\)/)
  expect(code).not.toMatch(/dialog\.select|dialog\.replace|navigateQuestSession/)
})

test("Quest click targets activate on release and consume the release", () => {
  expect(code).toMatch(/function activate\(/)
  expect(code).toMatch(/event\?\.stopPropagation\?\.\(\)/)
  expect(code).not.toMatch(/onMouseDown=/)
})

test("the board talks to one Quest Giver and never asks Jk to open worker sessions", () => {
  const session = readFileSync(join(root, "quest", "giver-session.ts"), "utf8")
  expect(code).toMatch(/<input[\s\S]*?onSubmit=/)
  expect(code).toMatch(/talkToQuestGiver\(props\.context, props\.root/)
  expect(code).toContain("clean turn, durable Quests")
  expect(session).toMatch(/session\.create|api\.create/)
  expect(session).toMatch(/agent:\s*["']quest-giver["']/)
  expect(session).toMatch(/api\.prompt/)
  expect(session).toMatch(/finally[\s\S]*?api\.(?:delete|remove)/)
  expect(session).not.toMatch(/readQuestGiverSession|saveQuestGiverSession|quest-giver-session\.json/)
  expect(code).not.toMatch(/type:\s*["']session["']/)
})

test("the Image 1 board is real-ledger driven with no screenshot-title fixtures", () => {
  for (const fake of ["Repair loader fallback", "PR #1842", "demoQuests", "screenshot-faithful", "quest.title.includes"]) expect(code).not.toContain(fake)
  expect(code).toMatch(/q\.stages/)
  expect(code).toMatch(/q\.setbacks/)
  expect(code).toMatch(/q\.usageInstructions/)
  expect(code).toMatch(/q\.sessions/)
  expect(code).not.toMatch(/ORCHESTRATOR|WORKER \$\{/)
  const capture = readFileSync(join(root, "scripts", "quest-board-demo-capture.tsx"), "utf8")
  expect(capture).toContain('import { QuestBoard } from "../quest/tui-active/quest-board"')
  expect(capture).not.toMatch(/function (?:Board|LeftRow|RightPane)\b/)
})
