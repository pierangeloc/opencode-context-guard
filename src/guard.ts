/**
 * The arithmetic behind the alert, kept free of any OpenCode import so both
 * halves of the plugin can share it and so it can be tested with plain node.
 */

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface CostTier {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface ModelInfo {
  id: string
  providerID: string
  name?: string
  limit: { context: number; output: number }
  cost: CostTier[]
}

export type Notify = "toast" | "chat" | "both" | "off"

export interface Options {
  /**
   * Raise a macOS notification from the server. The toast needs the TUI to have
   * loaded this plugin's terminal half; this works from any front-end, which is
   * the point of an alert you are meant to see when you are looking elsewhere.
   */
  system?: boolean
  /** Warning thresholds, crossed once each. */
  warn?: number[]
  /** The band that recommends a new session instead of compaction; null for none. */
  clearAt?: number | null
  /** Compact automatically on reaching `clearAt`. */
  compact?: boolean
  notify?: Notify
  /** Overrides keyed by `providerID/id`, or by bare model id. */
  models?: Record<string, Omit<Options, "models">>
}

export interface Settings {
  warn: number[]
  clearAt?: number | null
  compact: boolean
  notify: Notify
  system: boolean
}

export const DEFAULTS: Settings = {
  warn: [100_000, 150_000],
  clearAt: 200_000,
  compact: false,
  notify: "both",
  system: true,
}

/**
 * What the dialog writes and the server stores. The same shape at every scope,
 * so one editor can change a session, a model, or everything.
 */
export type Overrides = Partial<Omit<Options, "models">>

export type Scope = "session" | "global"

export function modelKey(model: { providerID: string; id: string }) {
  return `${model.providerID}/${model.id}`
}

/**
 * Four layers, narrowest last: a session the person edited by hand beats a
 * model rule, which beats what the config file asked for, which beats the
 * defaults. Each layer supplies only the fields it actually names.
 */
export function settingsFor(
  options: Options,
  model: { providerID: string; id: string },
  stored: { global?: Overrides; session?: Overrides } = {},
): Settings {
  const overrides = options.models ?? {}
  const perModel = overrides[modelKey(model)] ?? overrides[model.id] ?? {}
  return {
    ...DEFAULTS,
    ...strip(options),
    ...strip(perModel),
    ...strip(stored.global ?? {}),
    ...strip(stored.session ?? {}),
  }
}

function strip(options: Partial<Options>) {
  const { models: _models, ...rest } = options
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
}

/**
 * A threshold of 1 or less is a fraction of the model's window, so one setting
 * can mean the same thing to a 200k model and a 1M one.
 */
export function resolve(threshold: number, window: number) {
  return threshold <= 1 ? Math.round(threshold * window) : threshold
}

/** What the next turn will re-read: everything already in the window. */
export function contextTokens(tokens: TokenUsage) {
  return tokens.input + tokens.cache.read
}

/**
 * models.dev prices long contexts in tiers, so the bill depends on how full the
 * window is. A tier's `size` is the floor it applies above: the untiered entry
 * is the base price, and Anthropic's 200k tier doubles everything past 200k.
 */
export function tierFor(model: ModelInfo, used: number): CostTier | undefined {
  const tiers = model.cost ?? []
  if (tiers.length === 0) return undefined
  const sized = tiers.filter((tier) => tier.tier).sort((a, b) => a.tier!.size - b.tier!.size)
  let chosen = tiers.find((tier) => !tier.tier)
  for (const tier of sized) if (used > tier.tier!.size) chosen = tier
  return chosen ?? sized[0] ?? tiers[0]
}

/** List-price cost of one turn, in USD. Zero for a subscription, where prices are absent. */
export function turnCost(tokens: TokenUsage, tier?: CostTier) {
  if (!tier) return 0
  const millions =
    tokens.input * tier.input +
    (tokens.output + tokens.reasoning) * tier.output +
    tokens.cache.read * tier.cache.read +
    tokens.cache.write * tier.cache.write
  return millions / 1_000_000
}

export interface Band {
  /** 1-based position among the thresholds; 0 when none is crossed. */
  index: number
  /** The crossed threshold recommends a new session rather than compaction. */
  clear: boolean
  threshold: number
}

export function bandFor(used: number, settings: Settings, window: number): Band {
  const warn = [...settings.warn].map((value) => resolve(value, window)).sort((a, b) => a - b)
  // Null and undefined both mean no clear band: the dialog writes null to turn
  // one off, the config file simply omits it.
  const clearAt = settings.clearAt == null ? undefined : resolve(settings.clearAt, window)
  const thresholds = clearAt === undefined ? warn : [...warn.filter((value) => value < clearAt), clearAt]
  let index = 0
  for (const threshold of thresholds) if (used >= threshold) index++
  return {
    index,
    clear: index > 0 && clearAt !== undefined && thresholds[index - 1] === clearAt,
    threshold: index > 0 ? thresholds[index - 1] : 0,
  }
}

export function describe(input: {
  used: number
  band: Band
  model: ModelInfo
  tokens: TokenUsage
  willCompact: boolean
}) {
  const { used, band, model, tokens, willCompact } = input
  const window = model.limit?.context ?? 0
  // The share goes last and in parentheses on purpose. 125k is only 13% of a
  // 1M window and still re-read in full every turn, so leading with the share
  // would make a real warning read like a false alarm.
  const share = window > 0 ? ` (${Math.round((used / window) * 100)}% of a ${thousands(window)} window)` : ""
  const cost = turnCost(tokens, tierFor(model, used))
  const price = cost > 0 ? `, about ${money(cost)} a turn at list price` : ""
  const name = model.name ?? model.id
  const advice = willCompact
    ? "Compacting now."
    : band.clear
      ? "Finish here and start a new session; /compact if this task still needs the history."
      : "Consider /compact, or a new session at the next task boundary."
  return `Context is ${thousands(used)} tokens on ${name} — every turn re-reads all of it${price}${share}. ${advice}`
}

export function money(usd: number) {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3).replace(/0$/, "")}`
}

export function thousands(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

/**
 * Reads a threshold the way someone types it into a prompt: `150k`, `1.2M`,
 * `150000`, or `60%` and `0.6` for a share of the window. The dialog shows
 * thresholds as `100k, 150k`, so whatever it prints must parse back.
 */
export function parseThreshold(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase().replaceAll("_", "").replaceAll(",", "")
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|%)?$/.exec(trimmed)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (match[2] === "k") return Math.round(value * 1_000)
  if (match[2] === "m") return Math.round(value * 1_000_000)
  if (match[2] === "%") return value >= 100 ? undefined : value / 100
  // Bare numbers keep the rule the thresholds already use: 1 or less is a share.
  return value
}

/** A list of thresholds, in the order they will fire. Empty input means none. */
export function parseThresholds(text: string): number[] | undefined {
  const parts = text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return []
  const parsed = parts.map(parseThreshold)
  if (parsed.some((value) => value === undefined)) return undefined
  return (parsed as number[]).sort((a, b) => a - b)
}

/** The inverse, so the dialog can show what is set and have it typed back. */
export function formatThreshold(threshold: number) {
  return threshold <= 1 ? `${Math.round(threshold * 100)}%` : thousands(threshold)
}

export function formatThresholds(thresholds: number[]) {
  return thresholds.length === 0 ? "none" : thresholds.map(formatThreshold).join(", ")
}
