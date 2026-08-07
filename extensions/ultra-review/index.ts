import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { randomUUID } from "node:crypto"
import { Type } from "@sinclair/typebox"
import { SPECIALIZATIONS } from "./constants.ts"
import { executeReview } from "./engine.ts"
import { getScopes } from "./scopes.ts"
import { agentOptionsForSpec, judgeViaPi, runAgent } from "./pi-call.ts"
import { parseModelKey, type PiModelLike, type SpecId, type UiLike } from "./types.ts"
import { runWizard } from "./wizard.ts"

const toolSchema = Type.Object({
  scopeId: Type.String({ description: "Scope ID: working_tree, current_dir, branch_vs_<base> (e.g. branch_vs_origin/main), last_commit. Prefix branch_vs_ matches the branch scope." }),
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
        // Точный id; для семейства branch_vs_* принимаем любой префикс
        // (например, задокументированный branch_vs_main → branch_vs_origin/main).
        const scope =
          scopes.find((s) => s.id === params.scopeId) ??
          (params.scopeId.startsWith("branch_vs_") ? scopes.find((s) => s.id.startsWith("branch_vs_")) : undefined)
        if (!scope) {
          throw new Error(`Unknown scopeId "${params.scopeId}" — available: ${scopes.map((s) => s.id).join(", ") || "none"}`)
        }
        const specs = params.specIds.filter((s) => s in SPECIALIZATIONS) as SpecId[]
        const models = params.modelIds
          .map((id) => {
            const { provider, modelId } = parseModelKey(id)
            return ctx.modelRegistry.find(provider, modelId)
          })
          .filter((m): m is NonNullable<typeof m> => !!m)

        if (specs.length === 0) throw new Error("No valid specIds")
        if (models.length === 0) throw new Error("No valid modelIds")

        // Один session id на прогон ревью: все спеки/модели идут с ним — если
        // провайдер маршрутизирует по сессии, они попадают на тёплый узел
        // с разогретым prefix-кэшем (см. chatViaPi).
        const sessionId = randomUUID()
        const deps = {
          ui: ctx.ui,
          callModel: (m: PiModelLike, p: string, specId: string, s?: AbortSignal) =>
            specId === "judge"
              ? judgeViaPi(ctx.modelRegistry, m, p, s, 2, sessionId)
              : runAgent(ctx.modelRegistry, m, p, ctx.cwd, s, agentOptionsForSpec(specId), sessionId),
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

        const sessionId = randomUUID()
        const deps = {
          ui,
          callModel: (m: PiModelLike, p: string, specId: string, s?: AbortSignal) =>
            specId === "judge"
              ? judgeViaPi(ctx.modelRegistry, m, p, s, 2, sessionId)
              : runAgent(ctx.modelRegistry, m, p, ctx.cwd, s, agentOptionsForSpec(specId), sessionId),
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
