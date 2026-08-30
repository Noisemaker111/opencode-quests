import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const src = readFileSync(join(root, "quest", "tui-active", "quests.tsx"), "utf8")
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

test("quests uses beta-18684 slots and a mounted /quests command", () => {
  expect(code).toMatch(/Plugin\.define\s*\(\s*\{[\s\S]*?id:\s*["']quests["']/)
  expect(code).toMatch(/ui\.slot\(\{\s*append:\s*["']app["']/)
  expect(code).toMatch(/ui\.slot\(\{\s*append:\s*["']prompt\.footer["']/)
  expect(code).toMatch(/append:\s*["']sidebar\.content["']/)
  expect(code).toMatch(/keymap\.layer\s*\(/)
  expect(code).toMatch(/slash:\s*\{\s*name:\s*["']quests["']/)
  expect(code).not.toMatch(/slots\.register|keymap\.registerLayer|slashName/)
})

test("clickable count, slash and exact sidebar rows use supported dialogs", () => {
  expect(code).toMatch(/dialog\.select\s*\(/)
  expect(code).toMatch(/dialog\.show\s*\(/)
  expect(code).toMatch(/dialog\.confirm\s*\(/)
  expect(code).not.toMatch(/dialog\.replace/)
  expect(code).toMatch(/QuestChrome[\s\S]*?onMouseDown=\{\(\) => void openQuestDialog\(context\)\}/)
  expect(code).toMatch(/showQuestDetail\(props\.context, q\.id\)/)
  expect(code).toMatch(/title:\s*questRowLabel\(row\.quest\)/)
})

test("Quest detail creates, prompts, binds and navigates real sessions", () => {
  const session = readFileSync(join(root, "quest", "tui-session.ts"), "utf8")
  expect(session).toMatch(/session\.create\s*\(/)
  expect(session).toMatch(/session-claimed/)
  expect(session).toMatch(/session\.prompt\s*\(/)
  expect(session).toMatch(/router\.navigate\(\{ type: ["']session["'], sessionID \}\)/)
  expect(session).toMatch(/session-removed/)
  expect(code).toMatch(/navigateQuestSession\(props\.context, session\)/)
})
