#!/usr/bin/env bun
import { QuestStore } from "./store"
import { generateQuestIndex, readAllQuests } from "./index"
import { requestFingerprint } from "./privacy"
import { inferQuestKind } from "./schema"
import { previewMigration } from "./migration"
import { applyMigration } from "./migration-apply"
import { summarizeBoard, summarizeQuest } from "./board"
import { runQuestCommand } from "./commands"
const root = process.env.OPENCODE_PROJECT_ROOT ?? process.cwd(), store = new QuestStore(root), args = process.argv.slice(2)
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)) }
function quests() { return readAllQuests(root).flatMap((x) => x.quest ? [x.quest] : []) }
const cmd = args.shift() ?? "list"
if (cmd === "create" || cmd === "admit" || cmd === "prepend") {
  const title = args.join(" ") || "Untitled Quest"
  print(store.admit({ title, objective: title, kind: inferQuestKind(title), requestFingerprint: requestFingerprint({ title, objective: title }) }))
} else if (cmd === "view") print(runQuestCommand(store, "view", args[0]))
else if (cmd === "accept" || cmd === "assign") print(runQuestCommand(store, "accept", args[0], { owner: args[1] }))
else if (cmd === "execute" || cmd === "start" || cmd === "start-session") print(runQuestCommand(store, "start-session", args[0], { sessionID: args[1], callID: args[2], role: args[3] ?? "worker" }))
else if (cmd === "resume" || cmd === "reopen") print(runQuestCommand(store, "reopen", args[0], { reason: "Explicitly reopened", nextAction: "Assign an exact linked session" }))
else if (cmd === "abandon") print(runQuestCommand(store, "abandon", args[0], { reason: args.slice(1).join(" ") || undefined }))
else if (cmd === "archive") print(runQuestCommand(store, "archive", args[0], { reason: args.slice(1).join(" ") || undefined }))
else if (cmd === "delete") print(runQuestCommand(store, "delete", args[0], { confirmed: args.includes("--confirm") }))
else if (cmd === "turn-in" || cmd === "turn in") print(runQuestCommand(store, "turn-in", args[0], { reason: args.slice(1).join(" ") || "Explicitly turned in by user" }))
else if (cmd === "complete") print(runQuestCommand(store, "complete", args[0]))
else if (cmd === "refresh") print(store.read(args[0]))
else if (cmd === "index") console.log(generateQuestIndex(root))
else if (cmd === "migrate-preview") print(previewMigration(root))
else if (cmd === "migrate-apply") print(applyMigration(root))
else if (cmd === "list" || cmd === "board") print(summarizeBoard(quests(), args[0]))
else print(quests().map(summarizeQuest))
