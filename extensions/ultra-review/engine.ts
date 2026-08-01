import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GLOBAL_MAX_CONCURRENCY, PROVIDER_MAX_CONCURRENCY } from "./constants.ts"
import { git } from "./git.ts"
import { buildJudgePrompt, buildPrompt } from "./prompts.ts"
import type { ParsedFinding, PiModelLike, ReviewConfig, UiLike } from "./types.ts"

export interface ReviewDeps {
  ui: UiLike
  /**
   * Вызов модели: в проде это runAgent(ctx.modelRegistry, ...), в тестах — заглушка.
   * toolCalls = сколько раз агент читал файлы (0 — не пользовался read_file).
   */
  callModel(model: PiModelLike, prompt: string, signal?: AbortSignal): Promise<{ text: string; toolCalls: number }>
}

export interface TaskResult {
  modelName: string
  specName: string
  output: string
  toolCalls: number
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

// Формат находки из OUTPUT CONTRACT:
// - [SEVERITY] file:line -- description QUOTE: "..." CONF: 0.x
const FINDING_RE = /^- \[(\w+)\] (.+?):(\d+)(?:-(\d+))? -- (.*)$/m

function parseFindings(results: TaskResult[]): ParsedFinding[] {
  const out: ParsedFinding[] = []
  let idx = 1
  for (const r of results) {
    if (r.error) continue
    for (const line of r.output.split("\n")) {
      const m = line.match(FINDING_RE)
      if (!m) continue
      out.push({
        idx: idx++,
        severity: m[1].toUpperCase(),
        file: m[2],
        line: m[4] ? `${m[3]}-${m[4]}` : m[3],
        description: m[5].trim(),
        agent: r.modelName,
        spec: r.specName,
      })
    }
  }
  return out
}

interface JudgeVerdictLine {
  idx: number
  verdict?: string
  duplicate_of?: number | null
  new_severity?: string | null
  rationale?: string
}
interface JudgeOutput {
  verdicts?: JudgeVerdictLine[]
  kept?: number[]
}

/** Достаёт JSON из ответа судьи: срезает Markdown-обёртки и лишний текст. */
function parseJudgeJson(text: string): JudgeOutput | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as JudgeOutput
  } catch {
    return null
  }
}

const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }

function severityRank(severity: string): number {
  return SEV_RANK[severity.toUpperCase()] ?? 0
}

/** Живой прогресс-бар для статусной строки TUI: ▰▰▰▱▱▱ 3/12 */
const BAR_WIDTH = 12
function renderProgress(done: number, total: number): string {
  const filled = total === 0 ? BAR_WIDTH : Math.round((done / total) * BAR_WIDTH)
  return `Reviews: ${`▰`.repeat(filled)}${`▱`.repeat(BAR_WIDTH - filled)} ${done}/${total}`
}

function judgeVerdict(kept: ParsedFinding[]): string {
  if (kept.length === 0) return "APPROVED"
  const max = Math.max(...kept.map((f) => severityRank(f.severity)))
  if (max >= 3) return "REJECTED"
  return "REQUIRES_CHANGES"
}

function applyJudge(parsed: JudgeOutput, findings: ParsedFinding[], judgeModelName: string) {
  const verdictMap = new Map<number, JudgeVerdictLine>()
  for (const v of parsed.verdicts ?? []) verdictMap.set(v.idx, v)

  const kept: ParsedFinding[] = []
  const lines: string[] = []
  let valid = 0, duplicate = 0, fp = 0, downgrade = 0

  for (const f of findings) {
    const v = verdictMap.get(f.idx)
    const kind = (v?.verdict ?? "VALID").toUpperCase()
    const who = `${f.spec} (${f.agent})`
    if (kind === "DUPLICATE") {
      duplicate++
      lines.push(`- ~~(${f.idx}) [${f.severity}] ${f.file}:${f.line}~~ — duplicate of #${v?.duplicate_of ?? "?"} — ${who}`)
      continue
    }
    if (kind === "FALSE_POSITIVE") {
      fp++
      lines.push(`- ~~(${f.idx}) [${f.severity}] ${f.file}:${f.line}~~ — false positive${v?.rationale ? `: ${v.rationale}` : ""} — ${who}`)
      continue
    }
    if (kind === "DOWNGRADE") {
      downgrade++
      const ns = (v?.new_severity ?? f.severity).toUpperCase()
      kept.push({ ...f, severity: ns })
      lines.push(`- (${f.idx}) [${f.severity}→${ns}] ${f.file}:${f.line} — ${f.description} — ${who}${v?.rationale ? ` — ${v.rationale}` : ""}`)
      continue
    }
    valid++
    kept.push(f)
    lines.push(`- (${f.idx}) [${f.severity}] ${f.file}:${f.line} — ${f.description} — ${who}${v?.rationale ? ` — ${v.rationale}` : ""}`)
  }

  const verdict = judgeVerdict(kept)
  return {
    verdict,
    lines: [
      `## Judge (${judgeModelName})`,
      `**Valid:** ${valid} | **Duplicates:** ${duplicate} | **False positives:** ${fp} | **Downgraded:** ${downgrade}`,
      "",
      ...lines,
      "",
      `**Final verdict (judge):** ${verdict} — ${kept.length} kept finding${kept.length === 1 ? "" : "s"}`,
    ],
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

  const files = cfg.scope.files

  const tasks = cfg.deep
    ? cfg.models.flatMap((m) => cfg.specs.map((s) => ({ model: m, spec: s })))
    : cfg.specs.map((s, i) => ({ model: cfg.models[i % cfg.models.length], spec: s }))

  deps.ui.setStatus("ultra-review", `Running ${tasks.length} reviews (max ${PROVIDER_MAX_CONCURRENCY}/provider, ${GLOBAL_MAX_CONCURRENCY} global)...`)

  const limiter = createLimiter(GLOBAL_MAX_CONCURRENCY, PROVIDER_MAX_CONCURRENCY)
  let done = 0
  const results: TaskResult[] = await Promise.all(
    tasks.map(({ model, spec }) =>
      limiter.run(model.provider, async () => {
        try {
          const out = await deps.callModel(model, buildPrompt(cfg.scope, spec), signal)
          return {
            modelName: `${model.provider}/${model.id}`,
            specName: spec,
            output: out.text,
            toolCalls: out.toolCalls,
            error: null as string | null,
          }
        } catch (err) {
          return {
            modelName: `${model.provider}/${model.id}`,
            specName: spec,
            output: `ERROR: ${(err as Error).message}`,
            toolCalls: 0,
            error: (err as Error).message,
          }
        } finally {
          // Обновляем прогресс после каждого завершённого ревью, чтобы
          // в статусной строке TUI было видно движение.
          done++
          deps.ui.setStatus("ultra-review", renderProgress(done, tasks.length))
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
    lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ${v} | **Risk:** ${risk}`, "```text", r.output, "```")
    // Прозрачность: агент, который не читал файлы, ревьюил только манифест/diff
    if (r.toolCalls === 0) {
      lines.push("> ⚠️ Agent did not use read_file — reviewed from manifest/diff only.")
    }
    lines.push("")
  }

  // Консенсус — только по успешным задачам: упавшие не должны
  // размывать статистику и уводить итог в ложный APPROVED/REJECTED.
  const ok = results.length - errors
  const consensus = ok === 0 ? "NO_REVIEWS" : approved === ok ? "APPROVED" : rejected > ok / 2 ? "REJECTED" : "REQUIRES_HUMAN_REVIEW"
  lines.push("---", `**Consensus:** ${consensus} (${approved}/${ok} approved, ${rejected} rejected${errors ? `, ${errors} failed` : ""})`)

  // ── Судья (опционально): дедупликация + валидация находок финальным проходом.
  let finalVerdict = consensus
  if (cfg.judge && ok > 0) {
    const findings = parseFindings(results)
    if (findings.length > 0) {
      const judgeModel = cfg.models[0]
      deps.ui.setStatus("ultra-review", `Judge pass: validating ${findings.length} findings...`)
      try {
        const out = await deps.callModel(judgeModel, buildJudgePrompt(cfg.scope, findings), signal)
        const parsed = parseJudgeJson(out.text)
        if (parsed?.verdicts?.length) {
          const judged = applyJudge(parsed, findings, `${judgeModel.provider}/${judgeModel.id}`)
          lines.push(...judged.lines)
          finalVerdict = judged.verdict
        } else {
          lines.push("## Judge", "Judge output could not be parsed; keeping consensus.")
        }
      } catch (err) {
        lines.push("## Judge", `Judge pass failed: ${(err as Error).message}; keeping consensus.`)
      }
      deps.ui.setStatus("ultra-review", undefined)
    }
  }

  const report = lines.join("\n")
  // Ветка идёт в имя файла — санитизируем: только \w . - , без ведущих точек.
  const safeBranch = branch.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "unknown"
  const filename = `${ts}-${safeBranch}.md`
  const reviewsDir = join(cwd, "reviews")
  mkdirSync(reviewsDir, { recursive: true })
  writeFileSync(join(reviewsDir, filename), report, "utf-8")

  return { summary: `Tasks: ${ok}/${results.length}${errors ? ` (${errors} failed)` : ""} • Verdict: ${finalVerdict}`, filename }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
