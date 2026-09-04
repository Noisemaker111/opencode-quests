/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { readAllQuests } from "../index"
import type { Quest, QuestSession, QuestStage } from "../types"
import { questIndicator } from "../tui-model"
import { questLane } from "../board"
import { watchQuests } from "../watcher"
import { talkToQuestGiver } from "../giver-session"
import { progressGlyph, questProgress } from "../steps"

export const C = {
  bg: "#07111b", panel: "#0b1825", selected: "#112538", line: "#24364a",
  text: "#d8d4ca", muted: "#8f8a82", dim: "#596675", yellow: "#f2cf45",
  cyan: "#20c7e8", green: "#75c94f", orange: "#e99b45", red: "#e46c76",
}

export function projectRoot(context: any): string {
  const location = context.location ?? context.data?.location?.default?.()
  return location?.directory ?? process.cwd()
}

export function quests(root: string): Quest[] {
  return readAllQuests(root).flatMap((entry) => entry.quest ? [entry.quest] : [])
}

export function activate(event: any, action: () => void) { try { event?.stopPropagation?.() } catch {}; action() }

function repo(q: Quest): string {
  const value = q.scope.repos[0] ?? "workspace"
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function integrationSession(q: Quest) {
  return q.sessions.find((session) => session.sessionID === q.integrationOwner || session.openCodeSessionId === q.integrationOwner)
    ?? q.sessions.find((session) => session.role === "integration-owner" || session.agentRole === "orchestrator")
}

function branch(q: Quest): string { return integrationSession(q)?.branch ?? "workspace" }

function status(q: Quest): { label: string; color: string } {
  if (q.state === "Working") return { label: "RUNNING", color: C.green }
  if (q.state === "Needs attention") return { label: "STOPPED", color: C.red }
  if (q.state === "Verifying") return { label: "VERIFYING", color: C.orange }
  if (q.state === "Ready to complete" || q.state === "Complete") return { label: "READY", color: C.green }
  if (q.state === "Archived") return { label: "COMPLETED", color: C.muted }
  return { label: "WAITING", color: C.muted }
}

function stageRows(q: Quest): QuestStage[] {
  if (q.stages.length) return q.stages
  return q.deliverables.map((item) => ({
    id: item.id, title: item.title, status: item.status, needs: [], todos: [],
    claim: { repos: q.scope.repos, include: [], exclude: [] }, proofs: [], attempt: 1,
  }))
}

function badge(q: Quest): string {
  if (q.state === "Working") return "ACCEPTED"
  if (q.state === "Needs attention") return "NEEDS ATTENTION"
  if (q.state === "Ready to complete" || q.state === "Complete") return "TURN IN"
  return q.state.toUpperCase()
}

/** The provider/model that actually answered, else an honest placeholder. */
export function workerLabel(session: QuestSession): string {
  if (session.providerID && session.modelID) return `${session.providerID}/${session.modelID}`
  if (session.model) return session.model
  return session.agentRole && session.agentRole !== "worker" ? session.agentRole : "worker · model pending"
}

function sessionColor(state: string): string {
  if (state === "executing") return C.green
  if (state === "failed" || state === "missing" || state === "stale") return C.red
  if (state === "blocked") return C.orange
  if (state === "completed") return C.cyan
  return C.muted
}

function stepMark(status: string): string {
  if (status === "done") return "☑"
  if (status === "working") return "◐"
  if (status === "blocked") return "⊘"
  return "☐"
}

function stepColor(status: string): string {
  if (status === "done") return C.green
  if (status === "working") return C.orange
  if (status === "blocked") return C.red
  return C.dim
}

/** A one-row hairline instead of a filled bar. */
function Rule() {
  return <text fg={C.line} wrapMode="none" truncate flexShrink={0}>{"─".repeat(400)}</text>
}

function Row(props: { quest: Quest; selected: boolean; select: () => void }) {
  const p = () => questProgress(props.quest)
  const s = () => status(props.quest)
  const tone = () => p().total > 0 && p().done === p().total ? C.green : p().done > 0 ? C.yellow : C.dim
  return <box flexDirection="row" gap={1} paddingTop={1} paddingRight={1} backgroundColor={props.selected ? C.selected : "transparent"} flexShrink={0} onMouseUp={(event: any) => activate(event, props.select)}>
    <box width={1} backgroundColor={props.selected ? C.cyan : "transparent"} flexShrink={0} />
    <box width={3} alignItems="center" justifyContent="center" flexShrink={0}>
      <text fg={tone()} attributes={TextAttributes.BOLD}>{progressGlyph(p())}</text>
    </box>
    <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      <text fg={props.selected ? C.yellow : C.text} attributes={props.selected ? TextAttributes.BOLD : undefined} wrapMode="none" truncate>{props.quest.title}</text>
      <text fg={C.muted} wrapMode="none" truncate>{repo(props.quest)} · {branch(props.quest)}  <span fg={s().color}>{s().label}</span></text>
      <text fg={C.dim} wrapMode="none" truncate>{props.quest.nextAction}</text>
    </box>
    <text fg={tone()} flexShrink={0}>{p().done}/{p().total}</text>
  </box>
}

function SectionHeader(props: { label: string; count: number; open: boolean; toggle: () => void }) {
  return <text fg={C.muted} paddingLeft={1} paddingTop={1} wrapMode="none" truncate onMouseUp={(event: any) => activate(event, props.toggle)}>{props.open ? "⌄" : "›"} {props.label} · {props.count}</text>
}

function StageList(props: { quest: Quest }) {
  const rows = () => stageRows(props.quest)
  const p = () => questProgress(props.quest)
  return <box flexDirection="column" flexShrink={0}>
    <text fg={C.cyan} attributes={TextAttributes.BOLD}>QUEST STEPS <span fg={C.muted}>· {p().done}/{p().total} done</span></text>
    <Show when={rows().length > 0} fallback={<text fg={C.dim} paddingTop={1}>No steps planned yet. Ask the Quest Giver to plan this Quest.</text>}>
      <For each={rows()}>{(stage, index) => <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <box flexDirection="row" gap={1} flexWrap="no-wrap">
          <text fg={stepColor(stage.status)} width={2} flexShrink={0}>{stepMark(stage.status)}</text>
          <text fg={C.muted} width={3} flexShrink={0}>{String(index() + 1).padStart(2, "0")}</text>
          <text fg={stage.status === "done" ? C.muted : C.text} wrapMode="word" flexGrow={1} flexShrink={1}>{stage.title}</text>
          <text fg={stepColor(stage.status)} flexShrink={0}>{(stage.status ?? "pending") === "pending" ? (stage.attempt > 1 ? `ATTEMPT ${stage.attempt}` : "") : String(stage.status).toUpperCase()}</text>
        </box>
        <For each={stage.todos}>{(todo) => <text fg={C.muted} paddingLeft={7} wrapMode="word">{todo.status === "done" ? "✓" : "·"} {todo.title}</text>}</For>
        <For each={stage.proofs.filter((proof) => proof.attempt === stage.attempt)}>{(proof) => <text fg={proof.verdict === "FAIL" || proof.result === "failed" ? C.red : C.muted} paddingLeft={7} wrapMode="word">Evidence: {proof.kind} · {proof.verdict ?? proof.result ?? "recorded"}{proof.reason ? ` · ${proof.reason}` : ""}</text>}</For>
      </box>}</For>
    </Show>
  </box>
}

function AgentLog(props: { quest: Quest }) {
  return <box flexDirection="column" flexShrink={0}>
    <text fg={C.cyan} attributes={TextAttributes.BOLD}>AGENT LOG <span fg={C.muted}>· {props.quest.executingCount} running</span></text>
    <Show when={props.quest.sessions.length > 0} fallback={<text fg={C.dim} paddingTop={1}>No delegated work yet</text>}>
      <For each={props.quest.sessions}>{(session) => <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <box flexDirection="row" gap={1} flexWrap="no-wrap">
          <text fg={C.text} flexGrow={1} flexShrink={1} truncate wrapMode="none"><span fg={C.yellow}>{workerLabel(session)}</span> · {session.task ?? session.taskDescription ?? "delegated work"}</text>
          <text fg={sessionColor(session.state)} flexShrink={0}>{session.state.toUpperCase()}</text>
        </box>
        <Show when={session.result ?? session.evidence.at(-1)}>{(line) => <text fg={C.muted} paddingLeft={2} wrapMode="none" truncate>{line()}</text>}</Show>
      </box>}</For>
    </Show>
  </box>
}

export type TalkLine = { role: "Jk" | "Quest Giver"; text: string }

/** Enter sends; Shift+Enter or Ctrl+Enter inserts a newline, like the host composer. */
const COMPOSER_KEYS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
]

function Conversation(props: { quest?: Quest; lines: TalkLine[]; busy: boolean; send: (text: string) => void }) {
  let area: any
  const [rows, setRows] = createSignal(1)
  const height = () => Math.min(8, Math.max(3, rows()))
  const submit = () => {
    const text = String(area?.plainText ?? "").trim()
    if (!text || props.busy) return
    try { area?.clear?.() } catch {}
    setRows(1)
    props.send(text)
  }
  return <box flexDirection="column" border borderStyle="rounded" borderColor={props.busy ? C.yellow : C.line} paddingLeft={1} paddingRight={1} flexShrink={0}>
    <text fg={C.yellow} attributes={TextAttributes.BOLD} wrapMode="none" truncate>QUEST GIVER <span fg={C.muted}>· clean turn, durable Quests{props.quest ? ` · ${props.quest.title}` : " · new Quest"}</span></text>
    <Show when={props.lines.length > 0}>
      <scrollbox height={Math.min(12, props.lines.length * 2 + 1)} flexShrink={0} stickyScroll stickyStart="bottom">
        <box flexDirection="column" flexShrink={0}>
          <For each={props.lines}>{(line) => <text fg={line.role === "Jk" ? C.text : C.yellow} wrapMode="word" paddingTop={1}><span fg={C.muted}>{line.role}:</span> {line.text}</text>}</For>
          <Show when={props.busy}><text fg={C.muted} paddingTop={1}>Quest Giver is working…</text></Show>
        </box>
      </scrollbox>
    </Show>
    <textarea
      ref={(element: any) => { area = element }}
      focused
      height={height()}
      keyBindings={COMPOSER_KEYS}
      wrapMode="word"
      onSubmit={submit}
      onContentChange={() => setRows(String(area?.plainText ?? "").split("\n").length)}
      placeholder={props.busy ? "Quest Giver is working… you can queue the next message" : props.quest ? `Talk about “${props.quest.title}”… Enter sends · Shift+Enter newline` : "Tell the Quest Giver what you want done… Enter sends · Shift+Enter newline"}
      placeholderColor={C.dim}
      backgroundColor={C.panel}
      focusedBackgroundColor={C.selected}
      textColor={C.text}
      focusedTextColor={C.text}
      cursorColor={C.yellow}
    />
  </box>
}

function Detail(props: { quest: () => Quest }) {
  const q = props.quest
  const p = () => questProgress(q())
  const rows = () => stageRows(q())
  return <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingLeft={1} paddingRight={1} paddingTop={1} gap={1} backgroundColor={C.bg}>
    <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
      <text fg={C.yellow} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexShrink={1}>{q().title}</text>
      <text fg={status(q()).color} flexShrink={0}>{badge(q())}</text>
    </box>
    <text fg={C.cyan} wrapMode="none" truncate>{progressGlyph(p())} {p().done}/{p().total} steps <span fg={C.muted}>· {repo(q())} · {branch(q())} · {q().sessions.length} sessions · {q().evidence.tests.length} checks</span></text>
    <Rule />
    <scrollbox flexGrow={1} flexShrink={1}>
      <box flexDirection="column" gap={1} flexShrink={0} paddingRight={1}>
        <text fg={C.text} wrapMode="word">{q().objective}</text>
        <text fg={C.muted} wrapMode="word">Next: {q().nextAction}</text>
        <Rule />
        <StageList quest={q()} />
        <Show when={q().setbacks.length > 0}>
          <text fg={C.red} attributes={TextAttributes.BOLD}>SETBACKS</text>
          <For each={q().setbacks}>{(item) => <text fg={C.muted} wrapMode="word">Attempt {item.attempt} · {item.stageID} · {item.reason}</text>}</For>
        </Show>
        <Rule />
        <AgentLog quest={q()} />
        <Show when={q().usageInstructions.length > 0}>
          <Rule />
          <text fg={C.cyan} attributes={TextAttributes.BOLD}>QUEST PAYOUT</text>
          <For each={q().usageInstructions}>{(line) => <text fg={C.text} wrapMode="word">▸ {line}</text>}</For>
        </Show>
        <Show when={rows().length === 0 && q().acceptanceCriteria.length > 0}>
          <Rule />
          <text fg={C.cyan} attributes={TextAttributes.BOLD}>ACCEPTANCE</text>
          <For each={q().acceptanceCriteria}>{(item) => <text fg={item.satisfied ? C.green : C.muted} wrapMode="word">{item.satisfied ? "☑" : "☐"} {item.text}</text>}</For>
        </Show>
      </box>
    </scrollbox>
  </box>
}

type Lane = "incoming" | "current" | "completed"
const LANE_LABEL: Record<Lane, string> = { incoming: "NEW QUESTS", current: "CURRENT QUESTS", completed: "COMPLETED QUESTS" }

export function QuestBoard(props: { context: any; initialQuestID?: string }) {
  const root = projectRoot(props.context)
  const [all, setAll] = createSignal<Quest[]>([])
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.initialQuestID)
  const [open, setOpen] = createSignal<Record<Lane, boolean>>({ incoming: false, current: true, completed: false })
  const [lines, setLines] = createSignal<TalkLine[]>([])
  const [busy, setBusy] = createSignal(false)
  const refresh = () => {
    try {
      const list = quests(root)
      setAll(list)
      if (!selectedID() && list.length) setSelectedID([...list].filter((q) => q.state !== "Archived").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? list[0].id)
    } catch {}
  }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  const sorted = createMemo(() => [...all()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  const lanes = createMemo(() => ({
    incoming: sorted().filter((q) => questLane(q) === "unassigned"),
    current: sorted().filter((q) => ["assigned", "attention", "verifying", "ready"].includes(questLane(q))),
    completed: sorted().filter((q) => questLane(q) === "archived"),
  }))
  const selected = createMemo(() => all().find((q) => q.id === selectedID()))
  const running = () => all().reduce((total, q) => total + (q.state === "Archived" ? 0 : q.executingCount), 0)
  const toggle = (lane: Lane) => setOpen((prior) => ({ ...prior, [lane]: !prior[lane] }))
  const send = async (text: string) => {
    const quest = selected()
    setBusy(true)
    setLines((prior) => [...prior, { role: "Jk", text }])
    try {
      const reply = await talkToQuestGiver(props.context, root, text, quest && { id: quest.id, title: quest.title })
      setLines((prior) => [...prior, { role: "Quest Giver", text: reply || "Delegated. I am tracking it on the Quest board." }])
    } catch (error) {
      setLines((prior) => [...prior, { role: "Quest Giver", text: `Needs attention: ${String(error).slice(0, 180)}` }])
    } finally {
      setBusy(false)
      refresh()
    }
  }
  const Lane = (lane: Lane) => <>
    <SectionHeader label={LANE_LABEL[lane]} count={lanes()[lane].length} open={open()[lane]} toggle={() => toggle(lane)} />
    <Show when={open()[lane]}>
      <For each={lanes()[lane]}>{(q) => <Row quest={q} selected={selectedID() === q.id} select={() => setSelectedID(q.id)} />}</For>
      <Show when={!lanes()[lane].length}><text fg={C.dim} paddingLeft={3}>Nothing here</text></Show>
    </Show>
  </>
  return <box flexDirection="column" width="100%" height="100%" backgroundColor={C.bg}>
    <box flexDirection="row" justifyContent="space-between" height={3} paddingLeft={2} paddingRight={2} alignItems="center" backgroundColor={C.panel} flexShrink={0}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>QUESTS <span fg={C.dim}>│</span> <span fg={C.yellow}>Quest Giver</span></text>
      <text fg={C.muted}>{questIndicator(all())} · {running()} running</text>
    </box>
    <Rule />
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
      <box width={52} flexDirection="column" backgroundColor={C.panel} flexShrink={0}>
        <scrollbox flexGrow={1} flexShrink={1}>
          <box flexDirection="column" flexShrink={0} paddingBottom={1}>
            <text fg={selectedID() ? C.yellow : C.text} attributes={selectedID() ? undefined : TextAttributes.BOLD} padding={1} wrapMode="none" truncate onMouseUp={(event: any) => activate(event, () => setSelectedID(undefined))}>＋ NEW QUEST <span fg={C.muted}>· just describe what you want</span></text>
            {Lane("incoming")}
            {Lane("current")}
            {Lane("completed")}
          </box>
        </scrollbox>
      </box>
      <box width={1} backgroundColor={C.line} flexShrink={0} />
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
        <Show when={selected()} fallback={<box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} padding={2} gap={1}><text fg={C.yellow} attributes={TextAttributes.BOLD}>NEW QUEST</text><text fg={C.text} wrapMode="word">Tell the Quest Giver the outcome you want. It creates the Quest with its steps, delegates the work, and tracks everything here.</text></box>}>
          {(q) => <Detail quest={q} />}
        </Show>
        <box paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}>
          <Conversation quest={selected()} lines={lines()} busy={busy()} send={(text) => void send(text)} />
        </box>
      </box>
    </box>
  </box>
}
