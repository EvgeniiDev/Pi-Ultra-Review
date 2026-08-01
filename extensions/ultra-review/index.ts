import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { SPECIALIZATIONS } from "./constants.ts"
import { executeReview } from "./engine.ts"
import { getScopes } from "./scopes.ts"
import { runAgent } from "./pi-call.ts"
import type { PiModelLike, SpecId, UiLike } from "./types.ts"
import { runWizard } from "./wizard.ts"

const toolSchema = Type.Object({
  scopeId: Type.String({ description: "Scope ID: working_tree, branch_vs_main, last_commit" }),
  specIds: Type.Array(Type.String(), { description: "Specialization IDs" }),
  modelIds: Type.Array(Type.String(), { description: "Model IDs (provider/modelId)" }),
  deep: Type.Boolean({ description: "Full matrix (true) or round-robin (false)" }),
  judge: Type.Optional(Type.Boolean({ description: "Final judge pass to deduplicate and validate findings (default false)" })),
})

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ultra_review",
    label: "Ultra-Review",
    description: "Multi-model parallel code review via pi's own model layer",
    parameters: toolSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const scopes = getScopes(ctx.cwd)
        const scope = scopes.find((s) => s.id === params.scopeId) || scopes[0]
        const specs = params.specIds.filter((s) => s in SPECIALIZATIONS) as SpecId[]
        const models = params.modelIds
          .map((id) => {
            const i = id.indexOf("/")
            return i < 0 ? undefined : ctx.modelRegistry.find(id.slice(0, i), id.slice(i + 1))
          })
          .filter((m): m is NonNullable<typeof m> => !!m)

        if (!scope) throw new Error("No reviewable git scopes found")
        if (specs.length === 0) throw new Error("No valid specIds")
        if (models.length === 0) throw new Error("No valid modelIds")

        const deps = {
          ui: ctx.ui,
          callModel: (m: PiModelLike, p: string, s?: AbortSignal) => runAgent(ctx.modelRegistry, m, p, ctx.cwd, s),
        }
        const { summary, filename } = await executeReview(deps, ctx.cwd, { scope, specs, models, deep: params.deep, judge: params.judge ?? false }, signal)
        return { content: [{ type: "text", text: `✅ ${summary}\n📋 Report: reviews/${filename}` }], details: { filename } }
      } catch (err) {
        return { content: [{ type: "text", text: `❌ Error: ${(err as Error).message}` }], details: {} }
      }
    },
  })

  pi.registerCommand("ultra-review", {
    description: "Interactive multi-model code review wizard",
    handler: async (_args, ctx) => {
      // Расширяем ui до UiLike: notify() в типах pi уже не принимает "success",
      // а рантайм его переживает — у нас это часть контракта UiLike.
      const ui: UiLike = ctx.ui
      try {
        ui.notify("Starting ultra-review wizard...", "info")
        const cfg = await runWizard(ctx, ctx.cwd)
        ui.notify(`Running ${cfg.deep ? cfg.models.length * cfg.specs.length : cfg.specs.length} parallel reviews...`, "info")

        const deps = {
          ui,
          callModel: (m: PiModelLike, p: string, s?: AbortSignal) => runAgent(ctx.modelRegistry, m, p, ctx.cwd, s),
        }
        const { summary, filename } = await executeReview(deps, ctx.cwd, cfg)
        ui.notify(`✅ ${summary}\n📋 reviews/${filename}`, "success")
      } catch (err) {
        if ((err as Error).message !== "Wizard cancelled") {
          ui.notify(`Review failed: ${(err as Error).message}`, "error")
        }
      }
    },
  })
}
