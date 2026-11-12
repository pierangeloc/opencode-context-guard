import assert from "node:assert/strict"
import { test } from "node:test"
import {
  bandFor,
  contextTokens,
  describe as describeBand,
  formatThresholds,
  money,
  parseThreshold,
  parseThresholds,
  settingsFor,
  thousands,
  tierFor,
  turnCost,
  type ModelInfo,
  type Options,
  type TokenUsage,
} from "../src/guard.ts"

const opus: ModelInfo = {
  id: "claude-opus-5",
  providerID: "anthropic",
  name: "Claude Opus 5",
  limit: { context: 1_000_000, output: 64_000 },
  cost: [
    { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
    { tier: { type: "context", size: 200_000 }, input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  ],
}

const tokens = (used: number, extra: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 2,
  output: 400,
  reasoning: 0,
  cache: { read: used - 2, write: 0 },
  ...extra,
})

test("context size is what the next turn re-reads", () => {
  assert.equal(contextTokens(tokens(120_000)), 120_000)
})

test("bands fire in order and the last one is the clear band", () => {
  const settings = settingsFor({}, opus)
  assert.deepEqual(bandFor(50_000, settings, 200_000), { index: 0, clear: false, threshold: 0 })
  assert.equal(bandFor(100_000, settings, 200_000).index, 1)
  assert.equal(bandFor(149_999, settings, 200_000).index, 1)
  assert.equal(bandFor(160_000, settings, 200_000).index, 2)
  const top = bandFor(200_000, settings, 200_000)
  assert.equal(top.index, 3)
  assert.equal(top.clear, true)
})

test("a threshold of one or less is a share of the model's own window", () => {
  const settings = settingsFor({ warn: [0.25, 0.5], clearAt: 0.75 }, opus)
  assert.equal(bandFor(49_000, settings, 200_000).index, 0)
  assert.equal(bandFor(50_000, settings, 200_000).index, 1)
  assert.equal(bandFor(150_000, settings, 200_000).clear, true)
  // The same setting on a million-token model moves with it.
  assert.equal(bandFor(300_000, settings, 1_000_000).index, 1)
})

test("per-model overrides beat plugin options, which beat the defaults", () => {
  const options: Options = {
    warn: [80_000],
    models: { "anthropic/claude-opus-5": { warn: [60_000], clearAt: 120_000, compact: true } },
  }
  const forOpus = settingsFor(options, opus)
  assert.deepEqual(forOpus.warn, [60_000])
  assert.equal(forOpus.clearAt, 120_000)
  assert.equal(forOpus.compact, true)
  // Defaults still supply what nobody overrode.
  assert.equal(forOpus.notify, "both")
  assert.equal(forOpus.system, true)
  assert.equal(settingsFor({ system: false }, opus).system, false)

  const other = settingsFor(options, { providerID: "openai", id: "gpt-6" })
  assert.deepEqual(other.warn, [80_000])
  assert.equal(other.compact, false)
})

test("a bare model id matches any provider routing to it", () => {
  const settings = settingsFor({ models: { "claude-opus-5": { warn: [10_000] } } }, {
    providerID: "openrouter",
    id: "claude-opus-5",
  })
  assert.deepEqual(settings.warn, [10_000])
})

test("a tier's size is the floor it applies above, not a ceiling", () => {
  // The untiered entry is the base price; the 200k tier doubles everything past 200k.
  assert.equal(tierFor(opus, 150_000)!.input, 15)
  assert.equal(tierFor(opus, 200_000)!.input, 15)
  assert.equal(tierFor(opus, 200_001)!.input, 30)
  assert.equal(tierFor(opus, 400_000)!.input, 30)
  assert.equal(tierFor({ ...opus, cost: [] }, 10), undefined)
})

test("a turn costs what it re-reads, not what it writes", () => {
  const usage = tokens(200_000)
  const cost = turnCost(usage, tierFor(opus, 200_000))
  // 199_998 cache reads at $1.50/M are $0.300 of it; 400 output tokens at $75/M are $0.030.
  assert.ok(cost > 0.329 && cost < 0.331, `unexpected ${cost}`)
  assert.equal(turnCost(usage, undefined), 0)
})

test("the message names the model, the size, the price and the share", () => {
  const settings = settingsFor({}, opus)
  const usage = tokens(200_000)
  const text = describeBand({
    used: 200_000,
    band: bandFor(200_000, settings, 1_000_000),
    model: opus,
    tokens: usage,
    willCompact: false,
  })
  assert.match(text, /200k tokens on Claude Opus 5/)
  assert.match(text, /every turn re-reads all of it/)
  assert.match(text, /\$0\.33 a turn/)
  assert.match(text, /\(20% of a 1M window\)/)
  assert.match(text, /start a new session/)
})

test("a low share never contradicts the warning", () => {
  // 137k is 14% of a 1M window and still re-read in full every turn.
  const text = describeBand({
    used: 137_000,
    band: { index: 1, clear: false, threshold: 100_000 },
    model: opus,
    tokens: tokens(137_000),
    willCompact: false,
  })
  assert.match(text, /^Context is 137k tokens on Claude Opus 5 — every turn re-reads all of it/)
  assert.match(text, /\(14% of a 1M window\)\. Consider/)
})

test("a subscription model with no prices says nothing about money", () => {
  const free = { ...opus, cost: [] }
  const settings = settingsFor({}, free)
  const text = describeBand({
    used: 120_000,
    band: bandFor(120_000, settings, 200_000),
    model: free,
    tokens: tokens(120_000),
    willCompact: false,
  })
  assert.doesNotMatch(text, /\$/)
  assert.match(text, /Consider \/compact/)
})

test("window sizes read the way people say them", () => {
  assert.equal(thousands(137_000), "137k")
  assert.equal(thousands(1_000_000), "1M")
  assert.equal(thousands(1_500_000), "1.5M")
  assert.equal(thousands(400), "400")
})

test("an unknown window drops the share rather than dividing by zero", () => {
  const unknown = { ...opus, limit: { context: 0, output: 0 } }
  const text = describeBand({
    used: 120_000,
    band: { index: 1, clear: false, threshold: 100_000 },
    model: unknown,
    tokens: tokens(120_000),
    willCompact: false,
  })
  assert.doesNotMatch(text, /window/)
})

test("a session's own thresholds beat everything else", () => {
  const options: Options = { warn: [80_000], models: { "anthropic/claude-opus-5": { warn: [60_000] } } }
  const global = settingsFor(options, opus, { global: { warn: [50_000] } })
  assert.deepEqual(global.warn, [50_000])

  const session = settingsFor(options, opus, { global: { warn: [50_000] }, session: { warn: [30_000] } })
  assert.deepEqual(session.warn, [30_000])
  // A scope that names one field leaves the rest to the layer below.
  assert.equal(session.clearAt, 200_000)
})

test("null turns the clear band off; an omitted one is inherited", () => {
  const off = settingsFor({}, opus, { session: { clearAt: null } })
  assert.equal(bandFor(1_000_000, off, 1_000_000).clear, false)
  // Both defaults still fire, nothing recommends a new session.
  assert.equal(bandFor(1_000_000, off, 1_000_000).index, 2)
  assert.equal(settingsFor({}, opus, { session: { warn: [10] } }).clearAt, 200_000)
})

test("thresholds parse the way people type them", () => {
  assert.equal(parseThreshold("150k"), 150_000)
  assert.equal(parseThreshold("1.2M"), 1_200_000)
  assert.equal(parseThreshold(" 150000 "), 150_000)
  assert.equal(parseThreshold("150,000"), 150_000)
  assert.equal(parseThreshold("60%"), 0.6)
  assert.equal(parseThreshold("0.6"), 0.6)
  assert.equal(parseThreshold("nonsense"), undefined)
  assert.equal(parseThreshold("-5k"), undefined)
  assert.equal(parseThreshold("0"), undefined)
  // 100% of the window is not a warning anyone can act on.
  assert.equal(parseThreshold("100%"), undefined)
})

test("a list of thresholds comes back sorted, and all-or-nothing", () => {
  assert.deepEqual(parseThresholds("150k, 100k"), [100_000, 150_000])
  assert.deepEqual(parseThresholds("100k 150k"), [100_000, 150_000])
  assert.deepEqual(parseThresholds("   "), [])
  assert.equal(parseThresholds("100k, oops"), undefined)
})

test("what the dialog shows can be typed back into it", () => {
  assert.equal(formatThresholds([100_000, 150_000, 0.6]), "100k, 150k, 60%")
  assert.deepEqual(parseThresholds(formatThresholds([100_000, 150_000])), [100_000, 150_000])
  assert.deepEqual(parseThresholds(formatThresholds([0.6])), [0.6])
  assert.equal(formatThresholds([]), "none")
})

test("money reads at both ends of the scale", () => {
  assert.equal(money(1.5), "$1.50")
  assert.equal(money(0.325), "$0.325")
  assert.equal(money(0.03), "$0.03")
})
