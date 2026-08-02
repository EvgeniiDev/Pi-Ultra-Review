import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GLOBAL_MAX_CONCURRENCY, PROMPT_VERSION, PROVIDER_MAX_CONCURRENCY } from "./constants.ts"
import { git } from "./git.ts"
import { buildJudgePrompt, buildPrompt, REVIEW_SPECS } from "./prompts.ts"
import { assertSpecId, type PiModelLike, type ReviewConfig, type Severity, type SimplifyAction, type SimplifyRisk, type UiLike } from "./types.ts"

export interface ReviewDeps {
  ui: UiLike
  /**
   * Вызов модели: в проде это runAgent(ctx.modelRegistry, ...), в тестах — заглушка.
   * readFiles = пути, которые агент реально читал (для валидации находок).
   */
  callModel(model: PiModelLike, prompt: string, specId: string, signal?: AbortSignal): Promise<{ text: string; toolCalls: number; readFiles: string[] }>
}

export interface TaskResult {
  modelName: string
  specName: string
  output: string
  toolCalls: number
  readFiles: string[]
  error: string | null
}

/** Находка после серверной валидации. */
export interface ValidatedFinding {
  severity: Severity
  category?: string
  file: string
  line: number
  lineEnd?: number | null
  side?: string
  title: string
  trigger?: string
  impact?: string
  fix?: string
  evidence?: string
  risk?: SimplifyRisk
  action?: SimplifyAction
  reuseTarget?: string
}

/** Находка с метаданными задачи — то, что видит судья. */
export interface JudgedFinding extends ValidatedFinding {
  idx: number
  agent: string
  spec: string
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

// ─────────────────────────────────────────────────────────────────────────────
// Парсинг и серверная валидация вывода (verdict/risk считает инструмент).
// ─────────────────────────────────────────────────────────────────────────────

interface JsonFinding {
  severity?: unknown
  category?: unknown
  file?: unknown
  line?: unknown
  lineEnd?: unknown
  side?: unknown
  title?: unknown
  trigger?: unknown
  impact?: unknown
  fix?: unknown
  evidence?: unknown
  risk?: unknown
  action?: unknown
  reuseTarget?: unknown
}
interface JsonReviewOutput {
  context?: unknown
  findings?: JsonFinding[]
}

const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }
const SEV_NAME: Record<number, string> = { 4: "CRITICAL", 3: "HIGH", 2: "MEDIUM", 1: "LOW" }

function severityRank(severity: string): number {
  return SEV_RANK[severity.toUpperCase()] ?? 0
}

// Легаси-формат (однострочные находки) — фолбэк, если модель не выдала JSON
const LEGACY_FINDING_RE = /^- \[(\w+)\] (.+?):(\d+)(?:-(\d+))? -- (.*)$/m

/**
 * Кандидаты на JSON-вердикт из ответа модели. Модели оборачивают вердикт
 * прозой, фенсами и кодом с фигурными скобками — поэтому ищем по очереди:
 * 1) все ```json / ```-фенсы (по порядку);
 * 2) сбалансированный объект от ПОСЛЕДНЕГО "{" (вердикт обычно в конце);
 * 3) срез первого { … последнего } (последний шанс).
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = []
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
  for (const m of text.matchAll(fenceRe)) {
    const cand = m[1].trim()
    if (cand) out.push(cand)
  }
  // Сбалансированный объект от ПОСЛЕДНЕГО "{": вердикт обычно в конце.
  // Собрать индексы { сразу — обратный проход через lastIndexOf(fromIndex)
  // при fromIndex=-1 клампится в 0 и зацикливается на первом символе.
  const opens: number[] = []
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) opens.push(i)
  for (let n = opens.length - 1; n >= 0; n--) {
    const idx = opens[n]
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = idx; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === "\\") esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          out.push(text.slice(idx, i + 1))
          break
        }
      }
    }
  }
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) out.push(text.slice(start, end + 1))
  return out
}

function parseReviewOutput(text: string): { ok: true; output: JsonReviewOutput } | { ok: false; reason: string } {
  // Сначала — прямой JSON: срезаем ```json-фенсы по краям (ответ ровно блоком),
  // затем — все кандидаты из jsonCandidates (проза вокруг JSON, фенсы, скобки).
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim()
  for (const candidate of [stripped, ...jsonCandidates(text)]) {
    if (!candidate) continue
    try {
      const obj = JSON.parse(candidate) as JsonReviewOutput
      if (obj && typeof obj === "object" && Array.isArray(obj.findings)) {
        return { ok: true, output: obj }
      }
      // JSON валиден, но это не ревью-вердикт (напр. вложенный объект находки
      // {severity:…} из прозы). Не выходим с ошибкой — ищем следующий кандидат,
      // в идеале — полноценный объект с findings[].
    } catch {
      // невалидный JSON — пробуем следующий кандидат
    }
  }
  // Легаси: "No issues found." / "- [SEV] file:line -- desc QUOTE: CONF:"
  const findings: JsonFinding[] = []
  for (const line of text.split("\n")) {
    const m = line.match(LEGACY_FINDING_RE)
    if (!m) continue
    const quote = m[5].match(/QUOTE:\s*"([^"]*)"/)?.[1]
    findings.push({
      severity: m[1].toUpperCase(),
      file: m[2],
      line: Number(m[3]),
      lineEnd: m[4] ? Number(m[4]) : null,
      title: m[5].replace(/\s*QUOTE:\s*"[^"]*"\s*CONF:\s*[\d.]+/i, "").trim(),
      evidence: quote,
    })
  }
  const hasVerdict = /^VERDICT:\s*\w+/mi.test(text)
  if (findings.length > 0 || hasVerdict) {
    return { ok: true, output: { context: "FULL", findings } }
  }
  return { ok: false, reason: "malformed output (expected JSON review)" }
}

interface ProcessedTask {
  context: string
  findings: ValidatedFinding[]
  rejectedCount: number
  malformed?: string
}

export function processTaskOutput(output: string, specId: string, scopeFiles: Set<string>, readFiles: Set<string>): ProcessedTask {
  const parsed = parseReviewOutput(output)
  if (!parsed.ok) return { context: "INSUFFICIENT", findings: [], rejectedCount: 0, malformed: parsed.reason }

  const spec = REVIEW_SPECS[assertSpecId(specId)]
  const allowed = new Set(spec.allowedSeverities)
  const maxAllowed = spec.allowedSeverities[spec.allowedSeverities.length - 1]
  const findings: ValidatedFinding[] = []
  let rejectedCount = 0

  // Для simplify риск/действие обязательны: находка без валидной пары — мусор.
  const RISKS = new Set(["safe", "confirm", "review"])
  const ACTIONS = new Set(["delete", "inline", "refactor", "parallelize"])
  const isSimplify = specId === "simplify"

  for (const f of parsed.output.findings ?? []) {
    const file = typeof f.file === "string" ? f.file.trim() : ""
    const line = typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? f.line : null
    const sev = typeof f.severity === "string" ? f.severity.toUpperCase() : ""

    if (!file || line === null) { rejectedCount++; continue } // нет файла/строки
    if (!(scopeFiles.has(file) || readFiles.has(file))) { rejectedCount++; continue } // файл не в скоупе и не читался
    if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(sev)) { rejectedCount++; continue } // неизвестная severity

    let risk: SimplifyRisk | undefined
    let action: SimplifyAction | undefined
    let reuseTarget: string | undefined
    if (isSimplify) {
      const rawRisk = typeof f.risk === "string" ? f.risk.toLowerCase() : ""
      const rawAction = typeof f.action === "string" ? f.action.toLowerCase() : ""
      if (!RISKS.has(rawRisk) || !ACTIONS.has(rawAction)) { rejectedCount++; continue }
      risk = rawRisk as SimplifyRisk
      action = rawAction as SimplifyAction
      const rt = typeof f.reuseTarget === "string" ? f.reuseTarget.trim() : ""
      reuseTarget = rt || undefined
    }

    const finalSev = allowed.has(sev as Severity) ? (sev as Severity) : maxAllowed
    findings.push({
      severity: finalSev,
      category: typeof f.category === "string" ? f.category : undefined,
      file,
      line,
      lineEnd: typeof f.lineEnd === "number" ? f.lineEnd : null,
      side: typeof f.side === "string" ? f.side : undefined,
      title: typeof f.title === "string" ? f.title : "",
      trigger: typeof f.trigger === "string" ? f.trigger : undefined,
      impact: typeof f.impact === "string" ? f.impact : undefined,
      fix: typeof f.fix === "string" ? f.fix : undefined,
      evidence: typeof f.evidence === "string" ? f.evidence : undefined,
      risk,
      action,
      reuseTarget,
    })
  }

  const context = typeof parsed.output.context === "string" ? parsed.output.context.toUpperCase() : "FULL"
  return { context: context === "INSUFFICIENT" || context === "PARTIAL" || context === "FULL" ? context : "FULL", findings, rejectedCount }
}

/** Политика вердикта — серверная, не от модели. LOW advisory. */
function taskVerdict(context: string, findings: ValidatedFinding[]): { verdict: string; risk: string } {
  const max = findings.reduce((acc, f) => Math.max(acc, severityRank(f.severity)), 0)
  if (context === "INSUFFICIENT") return { verdict: "NEEDS_CONTEXT", risk: "UNKNOWN" }
  if (context === "PARTIAL" && findings.length === 0) return { verdict: "NEEDS_CONTEXT", risk: "UNKNOWN" }
  if (max >= 3) return { verdict: "REJECTED", risk: SEV_NAME[max] }
  if (max === 2) return { verdict: "REQUIRES_CHANGES", risk: "MEDIUM" }
  if (max === 1) return { verdict: "APPROVED", risk: "LOW" }
  return { verdict: "APPROVED", risk: "NONE" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Судья
// ─────────────────────────────────────────────────────────────────────────────

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

function judgeVerdict(kept: ValidatedFinding[]): string {
  const max = kept.reduce((acc, f) => Math.max(acc, severityRank(f.severity)), 0)
  if (max >= 3) return "REJECTED"
  if (max === 2) return "REQUIRES_CHANGES"
  return "APPROVED"
}

function applyJudge(parsed: JudgeOutput, findings: JudgedFinding[], judgeModelName: string) {
  const verdictMap = new Map<number, JudgeVerdictLine>()
  for (const v of parsed.verdicts ?? []) verdictMap.set(v.idx, v)

  const kept: ValidatedFinding[] = []
  const lines: string[] = []
  let valid = 0, duplicate = 0, fp = 0, downgrade = 0

  for (const f of findings) {
    const v = verdictMap.get(f.idx)
    const kind = (v?.verdict ?? "VALID").toUpperCase()
    const who = `${f.spec} (${f.agent})`
    const where = `${f.file}:${f.line}`
    if (kind === "DUPLICATE") {
      duplicate++
      lines.push(`- ~~(${f.idx}) [${f.severity}] ${where}~~ — duplicate of #${v?.duplicate_of ?? "?"} — ${who}`)
      continue
    }
    if (kind === "FALSE_POSITIVE") {
      fp++
      lines.push(`- ~~(${f.idx}) [${f.severity}] ${where}~~ — false positive${v?.rationale ? `: ${v.rationale}` : ""} — ${who}`)
      continue
    }
    if (kind === "DOWNGRADE") {
      downgrade++
      const ns = (v?.new_severity ?? f.severity).toUpperCase()
      kept.push({ ...f, severity: ns as Severity })
      lines.push(`- (${f.idx}) [${f.severity}→${ns}] ${where} — ${f.title} — ${who}${v?.rationale ? ` — ${v.rationale}` : ""}`)
      continue
    }
    valid++
    kept.push(f)
    lines.push(`- (${f.idx}) [${f.severity}] ${where} — ${f.title} — ${who}${v?.rationale ? ` — ${v.rationale}` : ""}`)
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

// ─────────────────────────────────────────────────────────────────────────────
// Прогресс-бар
// ─────────────────────────────────────────────────────────────────────────────

const BAR_WIDTH = 12
function renderProgress(done: number, total: number): string {
  const filled = total === 0 ? BAR_WIDTH : Math.round((done / total) * BAR_WIDTH)
  return `Reviews: ${`▰`.repeat(filled)}${`▱`.repeat(BAR_WIDTH - filled)} ${done}/${total}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Основной прогон
// ─────────────────────────────────────────────────────────────────────────────

export async function executeReview(
  deps: ReviewDeps,
  cwd: string,
  cfg: ReviewConfig,
  signal?: AbortSignal,
): Promise<{ summary: string; filename: string }> {
  let branch = "unknown"
  try {
    branch = git("git rev-parse --abbrev-ref HEAD", cwd) || "unknown"
  } catch {
    // git недоступен (не репозиторий?) — ветка останется "unknown".
  }

  const files = cfg.scope.files
  const scopeFiles = new Set(files)

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
          const out = await deps.callModel(model, buildPrompt(cfg.scope, spec), spec, signal)
          return {
            modelName: `${model.provider}/${model.id}`,
            specName: spec,
            output: out.text,
            toolCalls: out.toolCalls,
            readFiles: out.readFiles,
            error: null as string | null,
          }
        } catch (err) {
          return {
            modelName: `${model.provider}/${model.id}`,
            specName: spec,
            output: `ERROR: ${(err as Error).message}`,
            toolCalls: 0,
            readFiles: [],
            error: (err as Error).message,
          }
        } finally {
          done++
          deps.ui.setStatus("ultra-review", renderProgress(done, tasks.length))
        }
      }),
    ),
  )

  deps.ui.setStatus("ultra-review", undefined)

  const ts = timestamp()
  const MAX_REPORT_FILES = 50
  const filesLine = files.length > MAX_REPORT_FILES ? `${files.slice(0, MAX_REPORT_FILES).join(", ")} (+${files.length - MAX_REPORT_FILES} more)` : files.join(", ")
  const lines = [`# Code Review: ${branch} — ${ts}`, "", `**Scope:** ${cfg.scope.label}`, `**Prompt v${PROMPT_VERSION}**`, `**Files:** ${filesLine || "N/A"}`, ""]
  let approved = 0, rejected = 0, errors = 0, needsContext = 0
  const allFindings: JudgedFinding[] = []
  let idx = 1

  for (const r of results) {
    if (r.error) {
      errors++
      lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ERROR | **Risk:** UNKNOWN`, "```text", r.output, "```", "")
      continue
    }

    const processed = processTaskOutput(r.output, r.specName, scopeFiles, new Set(r.readFiles))
    const { verdict, risk } = taskVerdict(processed.context, processed.findings)
    if (verdict === "APPROVED") approved++
    if (verdict === "REJECTED") rejected++
    if (verdict === "NEEDS_CONTEXT") needsContext++

    lines.push(`## ${r.modelName} (${r.specName})`, `**Verdict:** ${verdict} | **Risk:** ${risk} | **Context:** ${processed.context}`)

    if (processed.malformed) {
      lines.push("```text", r.output, "```", `> ⚠️ ${processed.malformed}`)
    } else if (processed.findings.length === 0) {
      lines.push("No findings.")
    } else {
      for (const f of processed.findings) {
        const where = `${f.file}:${f.line}${f.lineEnd && f.lineEnd !== f.line ? `-${f.lineEnd}` : ""}`
        const riskAction = f.risk && f.action ? ` (risk: ${f.risk}, action: ${f.action})` : ""
        const parts = [`- [${f.severity}] ${where}${f.side ? ` (${f.side})` : ""} — ${f.title}${riskAction}`]
        if (f.category) parts.push(`category: ${f.category}`)
        if (f.reuseTarget) parts.push(`reuse: ${f.reuseTarget}`)
        if (f.trigger) parts.push(`trigger: ${f.trigger}`)
        if (f.evidence) parts.push(`evidence: ${f.evidence}`)
        lines.push(parts.join("\n  "))
        allFindings.push({ ...f, idx: idx++, agent: r.modelName, spec: r.specName })
      }
    }
    if (processed.rejectedCount > 0) {
      lines.push(`> ⚠️ ${processed.rejectedCount} finding(s) rejected: missing file/line, file not in scope/read, or invalid severity${r.specName === "simplify" ? ", or missing/invalid risk/action (simplify)" : ""}.`)
    }
    if (r.toolCalls === 0 && !processed.malformed) {
      lines.push("> ⚠️ Agent did not use read_file — reviewed from manifest/diff only.")
    }
    lines.push("")
  }

  // Консенсус — только по вердиктным задачам; NEEDS_CONTEXT не считается ни за/против.
  const ok = results.length - errors
  const consensus = ok === 0 ? "NO_REVIEWS" : approved === ok ? "APPROVED" : rejected > ok / 2 ? "REJECTED" : "REQUIRES_HUMAN_REVIEW"
  lines.push("---", `**Consensus:** ${consensus} (${approved}/${ok} approved, ${rejected} rejected${errors ? `, ${errors} failed` : ""}${needsContext ? `, ${needsContext} needs context` : ""})`)

  // ── Судья (опционально)
  let finalVerdict = consensus
  if (cfg.judge && ok > 0) {
    if (allFindings.length > 0) {
      const judgeModel = cfg.models[0]
      deps.ui.setStatus("ultra-review", `Judge pass: validating ${allFindings.length} findings...`)
      try {
        const out = await deps.callModel(judgeModel, buildJudgePrompt(cfg.scope, allFindings), "judge", signal)
        const parsed = parseJudgeJson(out.text)
        if (parsed?.verdicts?.length) {
          const judged = applyJudge(parsed, allFindings, `${judgeModel.provider}/${judgeModel.id}`)
          lines.push(...judged.lines)
          finalVerdict = judged.verdict
        } else {
          lines.push("## Judge", "Judge output could not be parsed; keeping consensus.")
        }
      } catch (err) {
        lines.push("## Judge", `Judge pass failed: ${(err as Error).message}; keeping consensus.`)
      }
      deps.ui.setStatus("ultra-review", undefined)
    } else {
      lines.push("## Judge", "No findings to judge.")
    }
  }

  const report = lines.join("\n")
  const safeBranch = branch.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "unknown"
  const filename = `${ts}-${safeBranch}.md`
  const reviewsDir = join(cwd, "reviews")
  mkdirSync(reviewsDir, { recursive: true })
  writeFileSync(join(reviewsDir, filename), report, "utf-8")

  return { summary: `Tasks: ${ok}/${results.length}${errors ? ` (${errors} failed)` : ""}${needsContext ? ` (${needsContext} needs context)` : ""} • Verdict: ${finalVerdict}`, filename }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
