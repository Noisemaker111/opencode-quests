import type { Quest } from "./types"
export function exactFingerprintMatch(quests: Quest[], fingerprint: string): Quest | undefined { return quests.find((q) => q.requestFingerprint === fingerprint && !["Archived", "Complete"].includes(q.state)) }
export function similaritySuggestions(quests: Quest[], words: string[]): Quest[] {
  const terms = new Set(words.map((x) => x.toLowerCase()).filter((x) => x.length > 3))
  return quests.filter((q) => [...terms].some((x) => `${q.title} ${q.objective}`.toLowerCase().includes(x))).slice(0, 5)
}
