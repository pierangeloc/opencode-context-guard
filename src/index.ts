import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin"
import {
  bandFor,
  contextTokens,
  describe,
  modelKey,
  settingsFor,
  type ModelInfo,
  type Options,
  type Overrides,
  type Scope,
  type TokenUsage,
} from "./guard"
import { ContextGuard } from "./rpc"

/**
 * Watches what every model call re-reads and says so once per threshold. The
 * number that matters is `input + cache.read`: the whole window is re-sent on
 * each turn, so a long session pays for its own history over and over.
 */
export default Plugin.define({
  id: "contextguard",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const sessions = new Map<string, { parentID?: string; model?: { providerID: string; id: string } }>()
    let models = new Map<string, ModelInfo>()

    const loadModels = async () => {
      const listed = unwrap<ModelInfo[]>(await ctx.model.list()) ?? []
      models = new Map(listed.map((model) => [modelKey(model), model]))
    }

    // Durable, because editing any config file reloads plugins: an in-memory
    // map re-announces a threshold the person already dismissed.
    const firedKey = (sessionID: string) => `fired/${sessionID}`
    const firedBand = async (sessionID: string) => ((await ctx.storage.get(firedKey(sessionID))) as number) ?? 0
    const rearm = (sessionID: string) => ctx.storage.remove(firedKey(sessionID))

    const scopeKey = (scope: Scope, sessionID?: string) =>
      scope === "global" ? "overrides/global" : `overrides/session/${sessionID}`
    // Read on every check, so a threshold changed in one window applies in the
    // next turn of another without either of them reloading.
    const readOverrides = async (scope: Scope, sessionID?: string) =>
      ((await ctx.storage.get(scopeKey(scope, sessionID))) as Overrides | undefined) ?? {}

    const resolveSettings = async (sessionID: string, ref: { providerID: string; id: string }) =>
      settingsFor(options, ref, {
        global: await readOverrides("global"),
        session: await readOverrides("session", sessionID),
      })

    const sessionInfo = async (sessionID: string) => {
      const cached = sessions.get(sessionID)
      if (cached) return cached
      const session = unwrap<{ parentID?: string; model?: { providerID: string; id: string } }>(
        await ctx.session.get({ sessionID }),
      )
      const info = { parentID: session?.parentID, model: session?.model }
      sessions.set(sessionID, info)
      return info
    }

    const check = async (sessionID: string, tokens: TokenUsage) => {
      const session = await sessionInfo(sessionID)
      // Subagents carry their own context and die with their task; alerting on
      // them would fire on work the person cannot clear anyway.
      if (session.parentID) return

      const ref = session.model ?? unwrap<{ providerID: string; id: string }>(await ctx.model.default())
      if (!ref) return
      const model = models.get(modelKey(ref))
      if (!model) return

      const settings = await resolveSettings(sessionID, ref)
      const used = contextTokens(tokens)
      const band = bandFor(used, settings, model.limit?.context ?? 0)
      if (band.index === 0 || band.index <= (await firedBand(sessionID))) return
      await ctx.storage.set(firedKey(sessionID), band.index)

      const willCompact = band.clear && settings.compact
      const text = describe({ used, band, model, tokens, willCompact })
      console.log(`contextguard ${sessionID} ${text}`)

      if (settings.system && settings.notify !== "off") notifySystem(text)
      if (settings.notify === "chat" || settings.notify === "both") {
        await ctx.session.synthetic({
          sessionID,
          text: `[context-guard] ${text}\n(A notice for the user. No action is required from the assistant; carry on with the task.)`,
        })
      }
      if (willCompact) await ctx.session.compact({ sessionID })
    }

    await loadModels()

    const modelOf = async (sessionID?: string) => {
      const ref = sessionID
        ? ((await sessionInfo(sessionID)).model ?? unwrap<{ providerID: string; id: string }>(await ctx.model.default()))
        : unwrap<{ providerID: string; id: string }>(await ctx.model.default())
      return ref ? models.get(modelKey(ref)) : undefined
    }

    const state = async (sessionID?: string) => {
      const model = await modelOf(sessionID)
      const ref = model ?? { providerID: "", id: "" }
      const global = await readOverrides("global")
      const session = sessionID ? await readOverrides("session", sessionID) : {}
      return {
        effective: settingsFor(options, ref, { global, session }) as unknown as Record<string, unknown>,
        global,
        session,
        window: model?.limit?.context ?? 0,
        model: model?.name ?? model?.id ?? "",
      }
    }

    const registration = await ctx.rpc.register(ContextGuard, {
      settings: async (input) => state((input as { sessionID?: string }).sessionID),
      update: async (input, context) => {
        const { scope, sessionID, overrides } = input as {
          scope: Scope
          sessionID?: string
          overrides?: Overrides | null
        }
        if (scope === "session" && !sessionID) {
          return context.error("no_session", "Editing this session's thresholds needs a session", { scope })
        }
        if (overrides === null || overrides === undefined) await ctx.storage.remove(scopeKey(scope, sessionID))
        else await ctx.storage.set(scopeKey(scope, sessionID), overrides as Record<string, unknown>)
        // New thresholds the session has already passed should announce once,
        // rather than staying silent because an older, higher band was spent.
        if (sessionID) await rearm(sessionID)
        await registration.events.emit("changed", sessionID ? { scope, sessionID } : { scope })
        return state(sessionID)
      },
    })

    const controller = new AbortController()
    void (async () => {
      const events = ctx.event.subscribe({
        types: [
          "session.step.ended",
          "session.compaction.ended",
          "session.model.selected",
          "session.deleted",
          "model.updated",
        ],
        signal: controller.signal,
      })
      for await (const event of events) {
        try {
          const data = (event as { data?: Record<string, unknown> }).data ?? {}
          const sessionID = data.sessionID as string | undefined
          // The event stream is shared by every location, and each location
          // loads its own instance of this plugin with its own storage. Without
          // this, a session announces once per project the person has open.
          const where = (event as { location?: { directory?: string } }).location?.directory
          if (where && ctx.location?.directory && where !== ctx.location.directory) continue
          switch (event.type) {
            case "session.step.ended":
              if (sessionID && data.tokens) await check(sessionID, data.tokens as TokenUsage)
              break
            // Compaction empties the window, so every threshold is armed again.
            case "session.compaction.ended":
              if (sessionID) await rearm(sessionID)
              break
            case "session.model.selected":
              if (sessionID) sessions.delete(sessionID)
              break
            case "session.deleted":
              if (sessionID) {
                sessions.delete(sessionID)
                await rearm(sessionID)
              }
              break
            case "model.updated":
              await loadModels()
              break
          }
        } catch (error) {
          console.error("contextguard", error)
        }
      }
    })()

    return async () => {
      controller.abort()
      await registration.dispose()
    }
  },
})

/**
 * Fire and forget: a notification that fails must not interrupt the turn it is
 * commenting on, and the notice is already in the transcript either way.
 */
function notifySystem(text: string) {
  if (process.platform !== "darwin") return
  const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  const child = spawn("osascript", [
    "-e",
    `display notification ${quoted(text)} with title "Context" sound name "Submarine"`,
  ])
  child.on("error", (error) => console.error("contextguard notification", error))
  child.unref()
}

/** Some context methods answer like the HTTP client and wrap their result in `data`. */
function unwrap<T>(result: unknown): T | undefined {
  if (result && typeof result === "object" && !Array.isArray(result) && "data" in result) {
    return (result as { data: T }).data
  }
  return result as T | undefined
}
