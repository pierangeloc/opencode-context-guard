import { Rpc } from "@opencode/plugin/rpc"

/**
 * Settings are owned by the server, not the terminal. The sidebar and the
 * notification have to agree about when to fire, and only the server sees both
 * — so the dialog edits through here rather than keeping its own copy.
 */
const overrides = {
  type: "object",
  properties: {
    warn: { type: "array", items: { type: "number" } },
    clearAt: { type: ["number", "null"] },
    compact: { type: "boolean" },
    notify: { type: "string", enum: ["toast", "chat", "both", "off"] },
    system: { type: "boolean" },
  },
  additionalProperties: false,
} as const

const settings = {
  type: "object",
  properties: {
    warn: { type: "array", items: { type: "number" } },
    clearAt: { type: ["number", "null"] },
    compact: { type: "boolean" },
    notify: { type: "string" },
    system: { type: "boolean" },
  },
  required: ["warn", "compact", "notify", "system"],
  additionalProperties: false,
} as const

const state = {
  type: "object",
  properties: {
    /** What the plugin will actually do, every layer merged. */
    effective: settings,
    /** Only what each scope names, so the dialog can show what is overridden. */
    global: overrides,
    session: overrides,
    /** The model the session is on, for thresholds quoted as a share. */
    window: { type: "number" },
    model: { type: "string" },
  },
  required: ["effective", "global", "session", "window", "model"],
  additionalProperties: false,
} as const

export const ContextGuard = Rpc.define({
  id: "contextguard",
  methods: {
    settings: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
      output: state,
    },
    update: {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "global"] },
          sessionID: { type: "string" },
          /** Null clears the scope back to what the layer below it says. */
          overrides: { anyOf: [overrides, { type: "null" }] },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      output: state,
      errors: {
        no_session: {
          type: "object",
          properties: { scope: { type: "string" } },
          required: ["scope"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { scope: { type: "string" }, sessionID: { type: "string" } },
        required: ["scope"],
        additionalProperties: false,
      },
    },
  },
})
