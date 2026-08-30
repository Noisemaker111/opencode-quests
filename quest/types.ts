export const QUEST_SCHEMA = "opencode.quest/v1" as const
export const QUEST_STATES = ["Working", "Waiting", "Needs attention", "Verifying", "Ready to complete", "Complete", "Archived"] as const
export type QuestState = typeof QUEST_STATES[number]
export type TerminalSessionState = "completed" | "failed" | "cancelled" | "missing" | "stale"
export type SessionState = "planned" | "executing" | "waiting" | "blocked" | TerminalSessionState

export type QuestRelationship = {
  parents: string[]; subquests: string[]; dependencies: string[]; supersedes: string[]
  supersededBy?: string; duplicateOf?: string; mergedFrom: string[]; splitFrom?: string
}
export type Deliverable = { id: string; title: string; status: "pending" | "working" | "blocked" | "done"; evidence?: string[] }
export type AcceptanceCriterion = { id: string; text: string; satisfied: boolean; evidence?: string[] }
export type SessionDependency = {
  sessionID: string; file: string; reason: string
  status: "blocked" | "resuming" | "resumed" | "failed"
  resumeKey: string; resumeCount: number; resumedAt?: string; resumeLeaseExpiresAt?: string
}
export type QuestSession = {
  callID: string; taskID?: string; sessionID?: string; parentID?: string; role: string; model?: string; harness?: string; branch?: string; worktree?: string
  agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; openCodeSessionId?: string; runtimeSessionId?: string; runID?: string; task?: string
  scope?: Record<string, unknown>; dependency?: SessionDependency
  /** Persisted v1 aliases are read during migration only; new events use canonical fields. */
  parentSessionID?: string; openCodeSessionID?: string; harnessSessionID?: string; taskDescription?: string
  state: SessionState; evidence: string[]; deliverables: string[]; attempt: number; resumedFrom?: string; resumeRoot?: string
  updatedAt: string; lastHeartbeatAt?: string; leaseExpiresAt?: string; commandSummary?: string; result?: string
}
export type FileClaim = { sessionID?: string; repo: string; worktree?: string; include: string[]; exclude: string[]; state: "active" | "released" }
export type Evidence = {
  commits: Array<{ repo: string; hash: string; worktreeHead?: string; verified: boolean }>
  tests: Array<{ command: string; result: "passed" | "failed"; at: string; summary?: string }>
  builds: Array<{ name: string; result: "passed" | "failed"; at: string }>
  artifacts: Array<{ name: string; uri?: string; digest?: string; verified: boolean }>
  publish: Array<{ target: string; result: "succeeded" | "failed" | "credentials-limitation"; at: string }>
  review?: { verdict: "BLOCK" | "CONCERNS" | "CLEAN"; at: string; evidence?: string }
}
export type MigrationRecord = { sourcePath: string; line: number; start: number; end: number; raw: string; sha256: string; disposition: string }
export type QuestHistory = { eventID: string; at: string; type: string; lifecycleEpoch: number; summary: string }
export type CompletionPolicy = {
  requireSessions: boolean; requireCommits: boolean; requireTests: boolean; requireReview: boolean
  requireArtifacts: boolean; requirePublish: boolean; requireWorktreeEquality: boolean
}

export type Quest = {
  schema: typeof QUEST_SCHEMA; id: string; revision: number; lifecycleEpoch: number; createdAt: string; updatedAt: string
  title: string; objective: string; kind: "feature" | "fix" | "investigation" | "migration" | "multi-session" | "legacy"
  priority: "low" | "normal" | "high" | "urgent"; state: QuestState; reason: string; nextAction: string
  executingCount: number; executionChangedAt?: string; owner?: string; integrationOwner?: string; requestFingerprint?: string
  scope: { blastRadius: string; risk: "low" | "medium" | "high"; repos: string[]; include: string[]; exclude: string[] }
  relationships: QuestRelationship; deliverables: Deliverable[]; acceptanceCriteria: AcceptanceCriterion[]; usageInstructions: string[]
  sessions: QuestSession[]; claims: FileClaim[]; evidence: Evidence; unresolvedWork: string[]
  completionPolicy: CompletionPolicy; missingRequirements: string[]; notificationCursor?: string
  migration: { source?: string; previewedAt?: string; appliedAt?: string; records: MigrationRecord[]; legacyAttestation?: string }
  eventCursors: Record<string, number>; appliedEventIDs: string[]; history: QuestHistory[]; abandoned?: boolean
  extensions: Record<string, unknown>
}

export type QuestEventType =
  | "created" | "patched" | "session-planned" | "session-claimed" | "session-bound" | "session-state" | "session-removed" | "deliverable-state" | "evidence-added"
  | "verify" | "complete" | "archive" | "reopen" | "abandon" | "delete" | "supersede" | "duplicate" | "split" | "merge" | "migration-applied"

export type QuestEvent = {
  v: 1; eventID: string; questID: string; type: QuestEventType; at: string; source: string; sourceSequence: number
  expectedRevision?: number; causationID: string; lifecycleEpoch: number; payload: Record<string, unknown>
}

export type ParsedQuest = { quest?: Quest; body: string; rawFrontmatter: string; raw: string; readonly: boolean; errors: string[]; humanHash: string }

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  requireSessions: true, requireCommits: true, requireTests: true, requireReview: true,
  requireArtifacts: true, requirePublish: true, requireWorktreeEquality: false,
}
