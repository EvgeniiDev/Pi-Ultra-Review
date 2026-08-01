import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { extractFiles, git } from "./git.ts"
import { buildPrompt } from "./prompts.ts"
import type { PiModelLike, ReviewConfig, UiLike } from "./types.ts"

export interface ReviewDeps {
  ui: UiLike
  /** Вызов модели: в проде это callViaPi(ctx.modelRegistry, ...), в тестах — заглушка. */
  callModel(model: PiModelLike, prompt: string, signal?: AbortSignal): Promise<string>
}

export async function executeReview(
  deps: ReviewDeps,
  cwd: string,
  cfg: ReviewConfig,
  signal?: AbortSignal,
): Promise<{ summary: string; filename: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const branch = git("git rev-parse --abbrev-ref HEAD", cwd) || "unknown"
  const files = extractFiles(cfg.scope.diff)

  const tasks = cfg.deep
    ? cfg.models.flatMap((m) => cfg.specs.map((s) => ({ model: m, spec: s })))
    : cfg.specs.map((s, i) => ({ model: cfg.models[i % cfg.models.length], spec: s }))

  deps.ui.setStatus("ultra-review", `Running ${tasks.length} parallel reviews...`)

  const results = await Promise.all(
    tasks.map(async ({ model, spec }) => {
      try {
        return {
          modelName: `${model.provider}/${model.id}`,
          specName: spec,
          output: await deps.callModel(model, buildPrompt(cfg.scope.diff, spec), signal),
          error: null as string | null,
        }
      } catch (err) {
        return {
          modelName: `${model.provider}/${model.id}`,
          specName: spec,
          output: `ERROR: ${(err as Error).message}`,
          error: (err as Error).message,
        }
      }
    }),
  )

  deps.ui.setStatus("ultra-review", undefined)

  const lines = [`# Code Review: ${branch} — ${timestamp}`, "", `**Scope:** ${cfg.scope.label}`, `**Files:** ${files.join(", ") || "N/A"}`, ""]
  let approved = 0, rejected = 0

  for (const r of results) {
    const v = r.output.match(/VERDICT:\s*(\w+)/i)?.[1] || "UNKNOWN"
    const risk = r.output.match(/RISK:\s*(\w+)/i)?.[1] || "UNKNOWN"
    if (v === "APPROVED") approved++
    if (v === "REJECTED") rejected++
    lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ${v} | **Risk:** ${risk}`, "```text", r.output, "```", "")
  }

  const total = results.length
  const consensus = total === 0 ? "NO_REVIEWS" : approved === total ? "APPROVED" : rejected > total / 2 ? "REJECTED" : "REQUIRES_HUMAN_REVIEW"
  lines.push("---", `**Consensus:** ${consensus} (${approved}/${total} approved, ${rejected} rejected)`)

  const report = lines.join("\n")
  const filename = `${timestamp}-${branch.replace(/[/\\]/g, "-")}.md`
  const reviewsDir = join(cwd, "reviews")
  mkdirSync(reviewsDir, { recursive: true })
  writeFileSync(join(reviewsDir, filename), report, "utf-8")

  return { summary: `Tasks: ${results.filter((r) => !r.error).length}/${total} • Consensus: ${consensus}`, filename }
}
