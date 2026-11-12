import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import {
  bandFor,
  contextTokens,
  describe,
  formatThreshold,
  formatThresholds,
  modelKey,
  parseThreshold,
  parseThresholds,
  thousands,
  tierFor,
  turnCost,
  type ModelInfo,
  type Notify,
  type Overrides,
  type Scope,
  type Settings,
  type TokenUsage,
} from "./guard"
import { ContextGuard } from "./rpc"

interface Alert {
  band: number
  clear: boolean
  headline: string
  advice: string
}

const HOT = "#ff5f5f"
const COOL = "#a33a3a"

/**
 * A notification is easy to miss and a toast is gone in seconds. The sidebar is
 * where the person is already reading the context figure, so the warning lives
 * there until they act on it, pulsing so it catches an eye that is elsewhere.
 */
export default Plugin.define({
  id: "contextguard.tui",
  async setup(context) {
    const guard = context.client.rpc(ContextGuard)
    const location = context.location ?? context.data.location.default()
    const [alerts, setAlerts] = createSignal<Record<string, Alert>>({})
    const [hot, setHot] = createSignal(true)

    // A model list that is not ready yet costs us one notice, not the
    // listeners below, so a failed sync must not abort setup.
    await context.data.location.model.sync(location).catch(() => {})
    const modelFor = (ref: { providerID: string; id: string }) => {
      const listed = (context.data.location.model.list(location) ?? []) as ModelInfo[]
      return listed.find((model) => modelKey(model) === modelKey(ref))
    }

    /**
     * The server decides the thresholds; this half only draws them. Settings
     * arrive asynchronously, so they are cached per session and the first turn
     * of an unknown session simply primes the cache.
     */
    const settings = new Map<string, Settings>()
    const pending = new Set<string>()
    const loadSettings = (sessionID: string) => {
      if (pending.has(sessionID)) return
      pending.add(sessionID)
      void guard
        .settings({ sessionID })
        .then((state) => settings.set(sessionID, state.effective as unknown as Settings))
        .catch(() => {})
        .finally(() => pending.delete(sessionID))
    }

    const pulse = setInterval(() => setHot((on) => !on), 700)

    const stopStep = context.data.on("session.step.ended", (event) => {
      const data = (event as { data?: Record<string, unknown> }).data ?? {}
      const sessionID = data.sessionID as string | undefined
      const tokens = data.tokens as TokenUsage | undefined
      if (!sessionID || !tokens) return

      const session = context.data.session.get(sessionID) as
        | { parentID?: string; model?: { providerID: string; id: string } }
        | undefined
      if (!session || session.parentID) return
      const ref = session.model ?? context.ui.model?.current?.()
      if (!ref) return
      const model = modelFor(ref)
      if (!model) return

      const current = settings.get(sessionID)
      if (!current) return loadSettings(sessionID)
      if (current.notify === "off" || current.notify === "chat") return

      const used = contextTokens(tokens)
      const band = bandFor(used, current, model.limit?.context ?? 0)
      if (band.index === 0) {
        if (alerts()[sessionID]) setAlerts(({ [sessionID]: _gone, ...rest }) => rest)
        return
      }

      const cost = turnCost(tokens, tierFor(model, used))
      const alert: Alert = {
        band: band.index,
        clear: band.clear,
        headline: `${thousands(used)} context${cost > 0 ? ` · ~$${cost.toFixed(2)}/turn` : ""}`,
        advice: band.clear ? "start a new session" : "/compact, or new session soon",
      }
      const previous = alerts()[sessionID]
      setAlerts((current) => ({ ...current, [sessionID]: alert }))

      // The sidebar carries every turn from here on, so the toast only marks
      // the moment a new threshold is crossed.
      if (previous && previous.band >= band.index) return
      context.ui.toast.show({
        title: "Context",
        message: describe({ used, band, model, tokens, willCompact: band.clear && current.compact }),
        variant: band.clear ? "error" : "warning",
        duration: band.clear ? 12_000 : 8_000,
      })
    })

    const stopCompaction = context.data.on("session.compaction.ended", (event) => {
      const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
      if (sessionID) setAlerts(({ [sessionID]: _gone, ...rest }) => rest)
    })

    // Thresholds can be changed from another window, or by this one's dialog.
    const stopChanged = guard.events.on("changed", (event) => {
      const sessionID = (event.data as { sessionID?: string }).sessionID
      if (sessionID) settings.delete(sessionID)
      else settings.clear()
      for (const id of settings.keys()) loadSettings(id)
      if (sessionID) loadSettings(sessionID)
    })

    const unslot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => {
        if (!settings.has(sessionID)) loadSettings(sessionID)
        const alert = () => alerts()[sessionID]
        return (
          <box paddingTop={1}>
            <text fg={hot() ? HOT : COOL}>{alert() ? `▲ ${alert()!.headline}` : ""}</text>
            <text fg={hot() ? HOT : COOL}>{alert() ? alert()!.advice : ""}</text>
          </box>
        )
      },
    })

    /**
     * The thresholds are the one thing people will want to change, and editing
     * them in JSON means finding the file and knowing the key names. The dialog
     * stays open after each change so a round of tuning is one visit.
     */
    const edit = async (sessionID?: string) => {
      let scope: Scope = sessionID ? "session" : "global"
      for (;;) {
        const state = await guard.settings(sessionID ? { sessionID } : {}).catch(() => undefined)
        if (!state) return context.ui.toast.show({ message: "Context guard is not running", variant: "error" })

        const effective = state.effective as unknown as Settings
        const here = ((scope === "session" ? state.session : state.global) ?? {}) as Overrides
        const window = (state.window as number) ?? 0
        const inherited = (field: keyof Overrides) => (field in here ? "" : " (inherited)")

        let switched: Scope | undefined
        const choice = await context.ui.dialog.select({
          title: scope === "session" ? "Context thresholds · this session" : "Context thresholds · everywhere",
          options: [
            {
              title: `Warn at ${formatThresholds(effective.warn)}${inherited("warn")}`,
              value: "warn",
              description: "One notice each, the first time the context passes them",
            },
            {
              title: `New session at ${effective.clearAt == null ? "never" : formatThreshold(effective.clearAt)}${inherited("clearAt")}`,
              value: "clearAt",
              description: "The last threshold, where compacting stops being the advice",
            },
            {
              title: `Notify ${effective.notify}${inherited("notify")}`,
              value: "notify",
              description: "Sidebar and toast, the transcript, both, or neither",
            },
            {
              title: `Desktop notification ${effective.system ? "on" : "off"}${inherited("system")}`,
              value: "system",
            },
            {
              title: `Compact automatically ${effective.compact ? "on" : "off"}${inherited("compact")}`,
              value: "compact",
              description: "Run /compact for you at the last threshold",
            },
            {
              title: Object.keys(here).length > 0 ? "Clear these overrides" : "Nothing overridden here",
              value: "reset",
              disabled: Object.keys(here).length === 0,
              category: "Scope",
            },
          ],
          actions: [
            {
              bind: "ctrl+s",
              title: scope === "session" ? "Edit everywhere instead" : "Edit this session instead",
              selection: "none",
              onTrigger: () => {
                if (scope === "global" && !sessionID) {
                  return context.ui.toast.show({ message: "Open a session to scope this to it", variant: "warning" })
                }
                switched = scope === "session" ? "global" : "session"
                context.ui.dialog.clear()
              },
            },
          ],
        })

        if (switched) {
          scope = switched
          continue
        }
        if (!choice) return

        const save = async (patch: Overrides) => {
          const result = await guard
            .update({ scope, sessionID, overrides: Object.keys(patch).length === 0 ? null : patch })
            .catch((error: unknown) => {
              context.ui.toast.show({ message: String(error), variant: "error" })
              return undefined
            })
          if (result && sessionID) settings.set(sessionID, result.effective as unknown as Settings)
        }

        if (choice === "reset") await save({})
        if (choice === "system") await save({ ...here, system: !effective.system })
        if (choice === "compact") await save({ ...here, compact: !effective.compact })
        if (choice === "notify") {
          const picked = await context.ui.dialog.select({
            title: "Notify",
            current: effective.notify,
            options: [
              { title: "both", value: "both", description: "Sidebar, toast and a line in the transcript" },
              { title: "toast", value: "toast", description: "Sidebar and toast only" },
              { title: "chat", value: "chat", description: "A line in the transcript only" },
              { title: "off", value: "off", description: "Nothing; auto-compact still runs if it is on" },
            ],
          })
          if (picked) await save({ ...here, notify: picked as Notify })
        }
        if (choice === "warn") {
          const typed = await context.ui.dialog.prompt({
            title: `Warn at${window > 0 ? ` — window is ${thousands(window)}` : ""}`,
            placeholder: formatThresholds(effective.warn),
          })
          if (typed !== undefined) {
            const parsed = parseThresholds(typed)
            if (!parsed) context.ui.toast.show({ message: `Could not read "${typed}"`, variant: "error" })
            else await save({ ...here, warn: parsed })
          }
        }
        if (choice === "clearAt") {
          const typed = await context.ui.dialog.prompt({
            title: `New session at — a size, or "never"`,
            placeholder: effective.clearAt == null ? "never" : formatThreshold(effective.clearAt),
          })
          if (typed !== undefined) {
            const trimmed = typed.trim().toLowerCase()
            const off = trimmed === "" || trimmed === "never" || trimmed === "none" || trimmed === "off"
            const parsed = off ? null : parseThreshold(typed)
            if (parsed === undefined) context.ui.toast.show({ message: `Could not read "${typed}"`, variant: "error" })
            else await save({ ...here, clearAt: parsed })
          }
        }
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "contextguard.settings",
          title: "Context thresholds",
          group: "Context",
          palette: true,
          slash: { name: "context" },
          run: () => {
            const route = context.ui.router.current()
            void edit(route?.type === "session" ? route.sessionID : undefined)
          },
        },
      ],
    }))

    return () => {
      clearInterval(pulse)
      stopStep()
      stopCompaction()
      stopChanged()
      unslot?.()
    }
  },
})
