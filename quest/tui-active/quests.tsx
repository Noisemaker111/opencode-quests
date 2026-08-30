/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { readAllQuests } from "../index"
import { QuestStore } from "../store"
import type { Quest } from "../types"
import {
  applyQuestAction,
  questActions,
  questDetailFields,
  questClaimLabels,
  questErrorText,
  questPickerRows,
  questRowLabel,
  questSessionLabel,
  questSidebarLine,
  questsForSession,
} from "../tui-controller"
import { startQuestSession } from "../tui-session"
import { navigateQuestSession } from "../tui-navigation"
import { questIndicator } from "../tui-model"
import { watchQuests } from "../watcher"

function themeColors(context: any) {
  return {
    primary: context?.theme?.primary ?? "#7aa2f7",
    secondary: context?.theme?.secondary ?? "#9ece6a",
    error: context?.theme?.error ?? "#f7768e",
    text: context?.theme?.text ?? "#c0caf5",
    muted: context?.theme?.textMuted ?? "#565f89",
  }
}

function projectRoot(context: any) {
  const location = context.location ?? context.data?.location?.default?.()
  return location?.directory ?? process.cwd()
}

function loadQuests(root: string): Quest[] {
  return readAllQuests(root).flatMap((entry) => entry.quest ? [entry.quest] : [])
}

function QuestDetail(props: { context: any; questID: string }) {
  const root = projectRoot(props.context)
  const store = new QuestStore(root)
  const [quest, setQuest] = createSignal<Quest>()
  const [error, setError] = createSignal("")
  const refresh = () => {
    try { setQuest(store.read(props.questID)); setError("") } catch (cause) { setError(questErrorText(cause)) }
  }
  const action = async (act: ReturnType<typeof questActions>[number]) => {
    const q = quest()
    if (!q) return
    if (act.id === "start-session") {
      const result = await startQuestSession(props.context, store, q)
      if (!result.ok) setError(result.error)
      return
    }
    if (act.confirm) {
      let confirmed: boolean | undefined
      try { confirmed = await props.context.ui.dialog.confirm({ title: act.title, message: act.confirm, label: act.title }) }
      catch (cause) { setError(questErrorText(cause)); return }
      if (confirmed !== true) return
    }
    const result = applyQuestAction(store, act.command, q.id, act.id === "delete" ? { confirmed: true } : {})
    if (!result.ok) { setError(result.error); return }
    if (act.id === "delete") props.context.ui.dialog.clear()
    else refresh()
  }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  const colors = themeColors(props.context)
  return <box flexDirection="column" padding={1}>
    <Show when={error()}><text fg={colors.error}>Needs attention: {error()}</text></Show>
    <Show when={quest()} fallback={<text>Quest not found</text>}>
      {(q) => <box flexDirection="column">
        <For each={questDetailFields(q())}>{(field) => <text>{field}</text>}</For>
        <Show when={q().sessions.length}><text fg={colors.secondary}>Sessions</text></Show>
        <For each={q().sessions}>{(session) =>
          <text fg={session.openCodeSessionId || session.openCodeSessionID || (session.runtime !== "claude-code" && session.sessionID) ? colors.text : colors.muted} onMouseDown={() => void navigateQuestSession(props.context, session)}>▸ {questSessionLabel(session)}</text>}
        </For>
        <Show when={q().claims.length}><text fg={colors.secondary}>File claims</text></Show>
        <For each={questClaimLabels(q())}>{(claim) => <text>▸ {claim}</text>}</For>
        <text fg={colors.secondary}>Actions</text>
        <For each={questActions(q())}>{(act) => <text onMouseDown={() => void action(act)}>▸ {act.title}</text>}</For>
        <text fg={colors.muted} onMouseDown={() => { props.context.ui.dialog.clear(); void openQuestDialog(props.context) }}>Back to Quests</text>
      </box>}
    </Show>
  </box>
}

function showQuestDetail(context: any, questID: string) {
  const dialog = context?.ui?.dialog
  if (typeof dialog?.show !== "function") return
  dialog.show(() => <QuestDetail context={context} questID={questID} />)
}

async function openQuestDialog(context: any) {
  const dialog = context?.ui?.dialog
  if (typeof dialog?.select !== "function" || typeof dialog?.show !== "function") return
  try {
    const rows = questPickerRows(loadQuests(projectRoot(context)))
    let category = "Quests"
    const options = rows.flatMap((row) => {
      if (row.kind === "header") { category = row.label; return [] }
      return [{ value: row.quest.id, title: questRowLabel(row.quest), category, description: row.quest.reason, searchText: `${row.quest.id} ${row.quest.title}` }]
    })
    const selected = await dialog.select({ title: "Quests", placeholder: "Search Quests", options })
    if (typeof selected === "string") showQuestDetail(context, selected)
  } catch (cause) {
    if (typeof dialog.alert === "function") await dialog.alert({ title: "Quests", message: questErrorText(cause) })
  }
}

function QuestSessionPanel(props: { context: any; sessionID: string }) {
  const root = projectRoot(props.context)
  const [quests, setQuests] = createSignal<Quest[]>([])
  const refresh = () => { try { setQuests(loadQuests(root)) } catch {} }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  const colors = themeColors(props.context)
  const active = () => quests().filter((q) => q.state !== "Archived")
  const mine = () => questsForSession(active(), props.sessionID)
  const others = () => active().filter((q) => !mine().includes(q))
  return <box flexDirection="column">
    <text fg={colors.secondary} wrapMode="none" truncate onMouseDown={() => void openQuestDialog(props.context)}>{questIndicator(active())}</text>
    <For each={mine()}>{(q) =>
      <text fg={colors.text} wrapMode="none" truncate onMouseDown={() => showQuestDetail(props.context, q.id)}>▸ {questSidebarLine(q)}</text>}
    </For>
    <Show when={others().length}>
      <text fg={colors.muted} wrapMode="none" truncate>Other active</text>
      <For each={others()}>{(q) =>
        <text fg={colors.muted} wrapMode="none" truncate onMouseDown={() => showQuestDetail(props.context, q.id)}>· {questSidebarLine(q)}</text>}
      </For>
    </Show>
  </box>
}

function QuestChrome() {
  const context: any = usePlugin()
  const root = projectRoot(context)
  const [quests, setQuests] = createSignal<Quest[]>([])
  const refresh = () => { try { setQuests(loadQuests(root)) } catch {} }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  const colors = themeColors(context)
  return <text fg={colors.primary} wrapMode="none" truncate aria-label="Open Quest Log" onMouseDown={() => void openQuestDialog(context)}>{questIndicator(quests())}</text>
}

function QuestCommands(props: { context: any }) {
  try {
    props.context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "quests.open",
        title: "Open Quest Log",
        group: "System",
        palette: true,
        suggested: true,
        slash: { name: "quests" },
        run: () => void openQuestDialog(props.context),
      }],
    }))
  } catch (error) {
    console.error("[quests] keymap.layer failed", error)
  }
  return null
}

export default Plugin.define({
  id: "quests",
  setup(context) {
    try { context.ui.slot({ append: "app", render: () => <QuestCommands context={context} /> }) }
    catch (error) { console.error("[quests] ui.slot(app) failed", error) }
    try { context.ui.slot({ append: "prompt.footer", render: () => <QuestChrome /> }) }
    catch (error) { console.error("[quests] ui.slot(prompt.footer) failed", error) }
    try {
      context.ui.slot({ append: "sidebar.content", render: (props: { sessionID: string }) => <QuestSessionPanel context={context} sessionID={props.sessionID} /> })
    } catch (error) { console.error("[quests] ui.slot(sidebar.content) failed", error) }
  },
})
