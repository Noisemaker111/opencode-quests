/** @jsxImportSource @opentui/solid */
import { Plugin } from "../../tui-legacy"
import { createSignal, onCleanup, onMount } from "solid-js"
import { questIndicator } from "../tui-model"
import type { Quest } from "../types"
import { watchQuests } from "../watcher"
import { C, QuestBoard, activate, projectRoot, quests } from "./quest-board"

function openBoard(context: any, questID?: string) {
  if (typeof context?.ui?.router?.navigate === "function") {
    context.ui.router.navigate({ type: "plugin", id: "quests", name: "quests", data: questID ? { questID } : undefined })
    return
  }
  context?.ui?.dialog?.show?.(() => <QuestBoard context={context} initialQuestID={questID} />)
}

const STARTED = Symbol.for("opencode-config.quests.primary-route")
function Commands(props: { context: any }) {
  props.context.keymap.layer(() => ({ mode: "global", commands: [{ id: "quests.open", title: "Open Quest Giver", group: "System", palette: true, suggested: true, slash: { name: "quests" }, run: () => openBoard(props.context) }] }))
  onMount(() => {
    const state = globalThis as any
    if (!state[STARTED]) { state[STARTED] = true; openBoard(props.context) }
  })
  return null
}

function Footer(props: { context: any }) {
  const context: any = props.context, root = projectRoot(context)
  const [all, setAll] = createSignal<Quest[]>([])
  const refresh = () => { try { setAll(quests(root)) } catch {} }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  return <text fg={C.yellow} wrapMode="none" truncate onMouseUp={(event: any) => activate(event, () => openBoard(context))}>{questIndicator(all())} · Quest Giver</text>
}

export default Plugin.define({
  id: "quests",
  setup(context) {
    context.ui.router.register({ name: "quests", render: (route: any) => <QuestBoard context={context} initialQuestID={route.data?.questID} /> })
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
    context.ui.slot({ append: "prompt.footer", render: () => <Footer context={context} /> })
    context.ui.slot({ append: "sidebar.content", render: () => <text fg={C.muted} onMouseUp={(event: any) => activate(event, () => openBoard(context))}>Open Quest Giver</text> })
  },
})
