import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GLOBAL_MAX_CONCURRENCY, PROVIDER_MAX_CONCURRENCY } from "./constants.ts"
import { extractFiles, git } from "./git.ts"
import { buildPrompt } from "./prompts.ts"
import type { PiModelLike, ReviewConfig, UiLike } from "./types.ts"

export interface ReviewDeps {
  ui: UiLike
  /** Вызов модели: в проде это callViaPi(ctx.modelRegistry, ...), в тестах — заглушка. */
  callModel(model: PiModelLike, prompt: string, signal?: AbortSignal): Promise<string>
}

export interface TaskResult {
  modelName: string
  specName: string
  output: string
  error: string | null
}

/**
 * Ограничитель параллелизма: глобальный лимит + лимит на ключ (провайдер).
 * Смысл — не долбить один провайдер кучей одновременных запросов: у всех
 * моделей одного провайдера общий слот. Очередь сканируется целиком, чтобы
 * задача одного провайдера не блокировала (head-of-line) задачи другого.
 */
export function createLimiter(globalLimit: number, perKeyLimit: number) {
  const active = new Map<string, number>()
  let globalActive = 0
  const queue: Array<{ key: string; run: () => void }> = []

  const startNext = () => {
    while (queue.length > 0) {
      let started = false
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]
        if (globalActive < globalLimit && (active.get(item.key) ?? 0) < perKeyLimit) {
          queue.splice(i, 1)
          item.run()
          started = true
          break
        }
      }
      if (!started) break
    }
  }

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task = () => {
          globalActive++
          active.set(key, (active.get(key) ?? 0) + 1)
          fn().then(resolve, reject).finally(() => {
            globalActive--
            const left = (active.get(key) ?? 1) - 1
            if (left <= 0) active.delete(key)
            else active.set(key, left)
            startNext()
          })
        }
        // Слоты заняты — в очередь; освободится слот, startNext запустит.
        // Слоты свободны — стартуем сразу.
        if (globalActive < globalLimit && (active.get(key) ?? 0) < perKeyLimit) task()
        else queue.push({ key, run: task })
      })
    },
  }
}

export async function executeReview(
  deps: ReviewDeps,
  cwd: string,
  cfg: ReviewConfig,
  signal?: AbortSignal,
): Promise<{ summary: string; filename: string }> {
  let branch = "unknown"
  try {
    branch = git("git rev-parse --abbrev-ref HEAD", cwd) || "unknown"
  } catch {}

  const files = extractFiles(cfg.scope.diff)

  const tasks = cfg.deep
    ? cfg.models.flatMap((m) => cfg.specs.map((s) => ({ model: m, spec: s })))
    : cfg.specs.map((s, i) => ({ model: cfg.models[i % cfg.models.length], spec: s }))

  deps.ui.setStatus("ultra-review", `Running ${tasks.length} reviews (max ${PROVIDER_MAX_CONCURRENCY}/provider, ${GLOBAL_MAX_CONCURRENCY} global)...`)

  const limiter = createLimiter(GLOBAL_MAX_CONCURRENCY, PROVIDER_MAX_CONCURRENCY)
  const results: TaskResult[] = await Promise.all(
    tasks.map(({ model, spec }) =>
      limiter.run(model.provider, async () => {
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
    ),
  )

  deps.ui.setStatus("ultra-review", undefined)

  const ts = timestamp()
  const lines = [`# Code Review: ${branch} — ${ts}`, "", `**Scope:** ${cfg.scope.label}`, `**Files:** ${files.join(", ") || "N/A"}`, ""]
  let approved = 0, rejected = 0, errors = 0

  // Заякориваем regex на начало строки, чтобы не поймать "VERDICT:" из
  // цитат/примеров внутри ответа модели.
  const verdictRe = /^VERDICT:\s*(\w+)/mi
  const riskRe = /^RISK:\s*(\w+)/mi

  for (const r of results) {
    if (r.error) {
      errors++
      lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ERROR | **Risk:** UNKNOWN`, "```text", r.output, "```", "")
      continue
    }
    const v = r.output.match(verdictRe)?.[1] || "UNKNOWN"
    const risk = r.output.match(riskRe)?.[1] || "UNKNOWN"
    if (v === "APPROVED") approved++
    if (v === "REJECTED") rejected++
    lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ${v} | **Risk:** ${risk}`, "```text", r.output, "```", "")
  }

  // Консенсус — только по успешным задачам: упавшие не должны
  // размывать статистику и уводить итог в ложный APPROVED/REJECTED.
  const ok = results.length - errors
  const consensus = ok === 0 ? "NO_REVIEWS" : approved === ok ? "APPROVED" : rejected > ok / 2 ? "REJECTED" : "REQUIRES_HUMAN_REVIEW"
  lines.push("---", `**Consensus:** ${consensus} (${approved}/${ok} approved, ${rejected} rejected${errors ? `, ${errors} failed` : ""})`)

  const report = lines.join("\n")
  // Ветка идёт в имя файла — санитизируем: только \w . - , без ведущих точек.
  const safeBranch = branch.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "unknown"
  const filename = `${ts}-${safeBranch}.md`
  const reviewsDir = join(cwd, "reviews")
  mkdirSync(reviewsDir, { recursive: true })
  writeFileSync(join(reviewsDir, filename), report, "utf-8")

  return { summary: `Tasks: ${ok}/${results.length}${errors ? ` (${errors} failed)` : ""} • Consensus: ${consensus}`, filename }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
