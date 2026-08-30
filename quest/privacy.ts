import { createHash } from "node:crypto"

const SECRET = /(?:sk-[A-Za-z0-9_-]{12,}|gh[oprs]_[A-Za-z0-9_]{20,}|(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+)/gi
export function redact(value: string, max = 500): string {
  return value.replace(SECRET, "[REDACTED]").replace(/[\r\n\t]+/g, " ").slice(0, max)
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }
export function bounded<T>(values: T[], max = 500): T[] { return values.slice(-max) }
export function requestFingerprint(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item, 10_000).trim().replace(/\s+/g, " ") : item)
  return digest(normalized)
}
