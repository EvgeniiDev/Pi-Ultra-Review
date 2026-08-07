# Заимствования из code-that-fits-in-your-head: тесты-целостность, качество изменения, эвристики, rule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в ultra-review два спека (`test_integrity`, `change_quality`), именованные эвристики в `maintainability`/`style`, поле `rule` с серверным требованием для HIGH/CRITICAL и рендером blocker/suggestion, а также передачу git-истории в скоуп.

**Architecture:** Новые спеки — это записи `REVIEW_SPECS` в `prompts.ts` (как у `simplify`), зарегистрированные в `SPEC_IDS` (`types.ts`) и `SPECIALIZATIONS` (`constants.ts`). Поле `rule` валидируется серверно в `processTaskOutput` (reject, как risk/action у simplify) и рендерится в отчёте. Коммит-история — опциональное поле `Scope.commits`, заполняемое в `scopes.ts` и попадающее в общий префикс промпта (`# COMMIT HISTORY (untrusted)`), чтобы не ломать prefix-кэш.

**Tech Stack:** TypeScript, bun (`bun test`), pi extension SDK. Базовая линия: 55 тестов зелёные, `bun test` ~2s.

## Global Constraints

- `PROMPT_VERSION` в `constants.ts` → `"2026-08-08a.json"`.
- `MAX_COMMIT_CHARS = 20_000` в `constants.ts`.
- `test_integrity.allowedSeverities = ["LOW","MEDIUM","HIGH","CRITICAL"]`; `change_quality.allowedSeverities = ["LOW","MEDIUM","HIGH"]`.
- `rule` серверно обязателен для HIGH/CRITICAL (после капа allowedSeverities), опционален для LOW/MEDIUM.
- Blocker/suggestion выводится движком из severity (HIGH/CRITICAL → `[BLOCKER]`), поля `kind` нет.
- `change_quality` скрыт в мастере для скоупов без `diff` (current_dir).
- Механизм кап-исключения test_integrity — секция в спец-зоне промпта (после `# ROLE`), НЕ через `renderFileMetadata`: иначе общий префикс спеков с test-файлами разъехался бы (см. shared-prefix тест). Это уточнение дизайна — см. Task 4.
- Коммит-сообщения — untrusted данные: `redactSecrets` + sanitize + nonce-границы, как у диффа.
- README пишется по-человечески, без внутренних механизмов (AGENTS.md).

---

## File Structure

| Файл | Роль | Изменения |
|---|---|---|
| `extensions/ultra-review/types.ts` | Типы | `SPEC_IDS` += 2; `Scope.commits?: string`; `ValidatedFinding.rule?: string`; `JudgeFindingInput.rule?` |
| `extensions/ultra-review/prompts.ts` | Спеки и промпты | 2 новых спека; контракт `rule`; секция `# COMMIT HISTORY`; `truncateCommits`; `encloseDiff` label; эвристики; заметка test-файлов |
| `extensions/ultra-review/engine.ts` | Валидация и отчёт | rule-валидация; рендер tag/rule/счётчиков; `applyJudge` возвращает kept |
| `extensions/ultra-review/scopes.ts` | Скоупы | `commitHistory()` helper; заполнение `commits` |
| `extensions/ultra-review/constants.ts` | Константы | `SPECIALIZATIONS` += 2; `MAX_COMMIT_CHARS`; `PROMPT_VERSION` |
| `extensions/ultra-review/wizard.ts` | Мастер | фильтр `change_quality` для diff-less скоупов |
| `README.md` | Пользовательская документация | 2 направления, rule, константа |
| `docs/superpowers/specs/2026-08-08-review-borrowings-design.md` | Дизайн-док | правка механизма кап-исключения (Task 4) |
| тесты: `specs.test.ts`, `prompts.test.ts`, `engine.test.ts`, `scopes.test.ts`, `wizard.test.ts` | — | новые кейсы |

---

### Task 1: Регистрация двух новых спеков

**Files:**
- Modify: `extensions/ultra-review/types.ts`
- Modify: `extensions/ultra-review/constants.ts`
- Modify: `extensions/ultra-review/prompts.ts`
- Test: `extensions/ultra-review/specs.test.ts`

**Interfaces:**
- Consumes: существующие `ReviewSpec` (role/mission/investigate/ignore/severityGuidance/allowedSeverities), `SPEC_IDS`, `REVIEW_SPECS`.
- Produces: `SPEC_IDS` содержит `"test_integrity" | "change_quality"`; `REVIEW_SPECS.test_integrity` и `REVIEW_SPECS.change_quality` — полные контракты; `SPECIALIZATIONS` — их лейблы в мастере; `MAX_COMMIT_CHARS` (используется Task 6).

- [ ] **Step 1: Зарегистрировать id в types.ts**

`extensions/ultra-review/types.ts`, массив `SPEC_IDS`:

```ts
export const SPEC_IDS = [
  "security",
  "correctness",
  "performance",
  "maintainability",
  "style",
  "best_practices",
  "simplify",
  "test_integrity",
  "change_quality",
] as const
```

- [ ] **Step 2: Константы — лейблы мастера, кап коммитов, версия промптов**

`extensions/ultra-review/constants.ts`:

```ts
export const MAX_COMMIT_CHARS = 20_000
```

`SPECIALIZATIONS` — добавить две записи:

```ts
test_integrity: "Test Integrity (weakened gates, missing coverage, tautological tests)",
change_quality: "Change Quality (coherence, scope, commit hygiene)",
```

`PROMPT_VERSION` → `"2026-08-08a.json"`.

- [ ] **Step 3: Определить спек test_integrity в prompts.ts**

В `REVIEW_SPECS` (после `simplify`) — точное содержимое:

```ts
test_integrity: {
  role: "senior engineer specializing in test and verification integrity",
  mission:
    "Verify that the change's tests and verification gates are trustworthy: meaningful for the new behavior, not weakened to get green, and independent of the implementation.",
  investigate: [
    "Tests changed, weakened, skipped, or removed merely to make the implementation pass: deleted or relaxed assertions, broadened tolerances, .skip/.only/xit/xdescribe/#[ignore], conditional skips, exact checks converted to loose ones.",
    "An existing oracle rewritten without a requirement change: a previously meaningful test altered to match the new (possibly wrong) implementation.",
    "Broad suppressions or disabled checks: eslint-disable/@ts-ignore/type: ignore, commented-out assertions, try/catch swallowing test failures, jest.mock/patch that mocks away the code under test.",
    "Tautological tests: assertions that mirror the implementation line-for-line and cannot fail independently; tests that only check a call happened, not the outcome.",
    "Missing coverage for new or changed behavior: a branch, error path, or behavior visible in the diff with no test.",
    "Flaky patterns: time-based sleeps, random values without seeding, network or file access without isolation, dependence on global state or execution order.",
    "Assertions that cannot fail: expect(true), missing final assertion, mocks returning fixed values that match the assertion.",
    "Production code modified only to satisfy tests: parameters, branches, or exports added as test-shaped holes in production code.",
    "Tests that pass but do not exercise the new logic, e.g. a wrapper that ignores the changed branch.",
  ],
  ignore: [
    "Test style or readability without impact on trustworthiness.",
    "Test suite performance unless it forces skipping or flakiness.",
    "Missing tests for pre-existing behavior unrelated to the diff.",
    "Speculative test requirements not evidenced by the diff.",
    "Coverage-percentage complaints without a concrete untested behavior at risk.",
    "Production-code quality issues that belong to another perspective — report only the verification gap.",
  ],
  severityGuidance: [
    "CRITICAL: a gate protecting an irreversible or security-critical operation was disabled, or its oracle removed without replacement; use extremely rarely.",
    "HIGH: tests or gates weakened to make the change pass; material new behavior with no verification; a rewritten oracle that hides a regression.",
    "MEDIUM: meaningful behavior verified only weakly, flaky-prone patterns in new tests, or a real coverage gap for an edge case.",
    "LOW: minor verification hygiene with clear but limited consequence.",
  ],
  allowedSeverities: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
},
```

- [ ] **Step 4: Определить спек change_quality в prompts.ts**

```ts
change_quality: {
  role: "senior engineer reviewing change-set quality and commit hygiene",
  mission:
    "Assess the change set as a whole: is it coherent, well-scoped, free of unrelated or drive-by edits, and does its history or description explain the why?",
  investigate: [
    "Coherence: is the change architecturally coherent, or a grab-bag of unrelated edits? Can the change be summarized in one sentence of intent?",
    "Unrelated changes mixed in: cleanup, formatting, refactors, or dependency bumps bundled inside a behavior change without justification.",
    "Mechanical vs semantic separation: are generated, mechanical, or formatting edits distinguishable from semantic decisions in the diff?",
    "Commit hygiene (when history is available): subjects concise and imperative; messages explain non-obvious rationale; commits preserve coherent known-good or recoverable states; no micro-commits that do not build; no drive-by refactors inside behavior commits.",
    "Missing rationale: behavior changes without explanation; edits made only to make tests pass without a stated requirement change.",
    "Incompleteness: half-migrated code, TODOs without owners and exit conditions, dead paths left behind, commented-out code in the diff.",
    "Dependency changes without justification: new dependency, version bump, or lockfile churn with no stated reason.",
    "Scatter: one logical change spread across many files with no shared structure.",
    "Churn: the same lines rewritten multiple times within the change.",
  ],
  ignore: [
    "Code-level correctness, security, performance, or style issues — those belong to other perspectives; review the change set, not the lines.",
    "Test quality — that is the test_integrity perspective.",
    "Individual naming or style nits.",
    "Pure formatting noise that does not obscure the change.",
    "Commit-message pedantry without impact on review or recovery.",
  ],
  severityGuidance: [
    "HIGH: the change mixes unrelated work, or its history materially misleads review or recovery (e.g. a misleading commit message hiding a risky change).",
    "MEDIUM: notable scope creep, drive-by refactors, or rationale gaps that hinder review.",
    "LOW: minor hygiene — a noisy commit message or a small unrelated tweak.",
  ],
  allowedSeverities: ["LOW", "MEDIUM", "HIGH"],
},
```

- [ ] **Step 5: Написать тесты контрактов новых спеков**

`extensions/ultra-review/specs.test.ts`, блоки по образцу `simplify`:

```ts
describe("test_integrity spec", () => {
  test("registered in SPEC_IDS and accepted by assertSpecId", () => {
    expect(SPEC_IDS).toContain("test_integrity")
    expect(assertSpecId("test_integrity")).toBe("test_integrity")
  })

  test("full rule set, all four severities, tests are the subject", () => {
    const s = REVIEW_SPECS.test_integrity
    expect(s).toBeDefined()
    expect(s.allowedSeverities).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    expect(s.investigate).toHaveLength(9)
    expect(s.ignore).toHaveLength(6)
    expect(s.severityGuidance).toHaveLength(4)
    expect(s.mission).toContain("not weakened to get green")
  })
})

describe("change_quality spec", () => {
  test("registered in SPEC_IDS and accepted by assertSpecId", () => {
    expect(SPEC_IDS).toContain("change_quality")
    expect(assertSpecId("change_quality")).toBe("change_quality")
  })

  test("full rule set, no CRITICAL", () => {
    const s = REVIEW_SPECS.change_quality
    expect(s).toBeDefined()
    expect(s.allowedSeverities).toEqual(["LOW", "MEDIUM", "HIGH"])
    expect(s.investigate).toHaveLength(9)
    expect(s.ignore).toHaveLength(5)
    expect(s.severityGuidance).toHaveLength(3)
    expect(s.mission).toContain("coherent")
  })
})
```

- [ ] **Step 6: Прогнать тесты — старые должны пройти, новые — упасть**

Run: `bun test`
Expected: 2 новых теста FAIL (модуль ещё не содержит спеков — REJECT/TypeError), остальные PASS.

- [ ] **Step 7: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS (55 + 4 новых).

- [ ] **Step 8: Commit**

```bash
git add extensions/ultra-review/types.ts extensions/ultra-review/constants.ts extensions/ultra-review/prompts.ts extensions/ultra-review/specs.test.ts
git commit -m "feat(review): register test_integrity and change_quality specs"
```

---

### Task 2: Поле `rule` — контракт и серверная валидация

**Files:**
- Modify: `extensions/ultra-review/prompts.ts`
- Modify: `extensions/ultra-review/engine.ts`
- Modify: `extensions/ultra-review/types.ts`
- Test: `extensions/ultra-review/engine.test.ts`, `extensions/ultra-review/prompts.test.ts`

**Interfaces:**
- Consumes: `ValidatedFinding.rule` (тип из Task 1 — нет, добавляем здесь в `types.ts`).
- Produces: `ValidatedFinding.rule?: string`; ревьюер обязан указывать `rule` для HIGH/CRITICAL (reject иначе); судья получает `rule` в строке находки.

- [ ] **Step 1: Тип поля rule**

`extensions/ultra-review/types.ts`, `ValidatedFinding` — добавить поле:

```ts
rule?: string
```

`JudgeFindingInput` в `prompts.ts` — добавить:

```ts
rule?: string
```

- [ ] **Step 2: Контракт в OUTPUT CONTRACT**

`extensions/ultra-review/prompts.ts`, `buildPrompt`, секция `# OUTPUT CONTRACT`, schema — после `"evidence": "string"`:

```json
"rule": "string"
```

Field rules — после строки про evidence:

```
- rule: the heuristic or rule violated (e.g. cqs, cyclomatic>15, test_weakened,
  parse-don't-validate, n_plus_one). REQUIRED for HIGH and CRITICAL findings;
  optional for LOW/MEDIUM. Omit if no specific rule applies.
```

- [ ] **Step 3: Серверная валидация в processTaskOutput**

`extensions/ultra-review/engine.ts`, внутри цикла `for (const f of parsed.output.findings ?? [])` — после вычисления `finalSev` и до `findings.push(...)`:

```ts
const rule = typeof f.rule === "string" ? f.rule.trim() : ""
if ((finalSev === "HIGH" || finalSev === "CRITICAL") && !rule) {
  rejectedCount++
  continue
}
```

и в `findings.push(...)`:

```ts
rule: rule || undefined,
```

- [ ] **Step 4: Судья получает rule**

`extensions/ultra-review/prompts.ts`, `buildJudgePrompt` — в строку находки добавить после `| evidence: ${f.evidence}`:

```ts
${f.rule ? ` | rule: ${f.rule}` : ""}
```

- [ ] **Step 5: Тесты валидации rule**

`extensions/ultra-review/engine.test.ts`:

```ts
test("HIGH finding without rule is rejected (rule required for blockers)", () => {
  const out = `{"context":"FULL","findings":[{"severity":"HIGH","file":"src/a.ts","line":1,"title":"injection"}]}`
  const r = processTaskOutput(out, "security", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(0)
  expect(r.rejectedCount).toBe(1)
})

test("HIGH finding with rule passes through", () => {
  const out = `{"context":"FULL","findings":[{"severity":"HIGH","file":"src/a.ts","line":1,"title":"injection","rule":"sql_injection"}]}`
  const r = processTaskOutput(out, "security", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.findings[0].rule).toBe("sql_injection")
})

test("CRITICAL without rule rejected, LOW without rule kept", () => {
  const critical = processTaskOutput(`{"context":"FULL","findings":[{"severity":"CRITICAL","file":"src/a.ts","line":1,"title":"x"}]}`, "test_integrity", scopeFiles, readFiles)
  expect(critical.rejectedCount).toBe(1)
  const low = processTaskOutput(`{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"x"}]}`, "security", scopeFiles, readFiles)
  expect(low.findings).toHaveLength(1)
})
```

`extensions/ultra-review/prompts.test.ts`:

```ts
test("output contract documents the rule field", () => {
  const p = buildPrompt(scope, "security")
  expect(p).toContain('"rule": "string"')
  expect(p).toContain("REQUIRED for HIGH and CRITICAL findings")
})
```

- [ ] **Step 6: Прогнать тесты — красные**

Run: `bun test`
Expected: новые тесты FAIL (`rule` ещё не валидируется/не в контракте).

- [ ] **Step 7: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS.

- [ ] **Step 8: Commit**

```bash
git add extensions/ultra-review/prompts.ts extensions/ultra-review/engine.ts extensions/ultra-review/types.ts extensions/ultra-review/engine.test.ts extensions/ultra-review/prompts.test.ts
git commit -m "feat(review): rule field required for HIGH/CRITICAL findings, passed to judge"
```

---

### Task 3: Рендер blocker/suggestion, rule и счётчиков

**Files:**
- Modify: `extensions/ultra-review/engine.ts`
- Test: `extensions/ultra-review/engine.test.ts`

**Interfaces:**
- Consumes: `ValidatedFinding.rule` (Task 2), `applyJudge` возвращает kept-находки.
- Produces: строки отчёта с тегом `[BLOCKER]`/`[SUGGESTION]` и `rule: X`; финальный блок `**Blockers:** N | **Suggestions:** M`; `applyJudge` возвращает `kept`.

- [ ] **Step 1: applyJudge возвращает kept**

`extensions/ultra-review/engine.ts`, конец `applyJudge` — return:

```ts
return {
  verdict,
  kept,
  lines: [ ... ],
}
```

- [ ] **Step 2: Рендер находок спека**

`extensions/ultra-review/engine.ts`, в `executeReview`, блок рендера `for (const f of processed.findings)` — первую строку `parts` заменить:

```ts
const tag = f.severity === "HIGH" || f.severity === "CRITICAL" ? "[BLOCKER]" : "[SUGGESTION]"
const parts = [`- ${tag} [${f.severity}] ${where}${f.side ? ` (${f.side})` : ""} — ${f.title}${riskAction}`]
```

после `if (f.category) ...` добавить:

```ts
if (f.rule) parts.push(`rule: ${f.rule}`)
```

- [ ] **Step 3: Расширить сообщение о rejected-находках**

В `executeReview`, строка `> ⚠️ ${processed.rejectedCount} finding(s) rejected: ...` — заменить суффикс:

```ts
lines.push(`> ⚠️ ${processed.rejectedCount} finding(s) rejected: missing file/line, file not in scope/read, invalid severity${r.specName === "simplify" ? ", or missing/invalid risk/action (simplify)" : ""}, or missing rule (required for HIGH/CRITICAL).`)
```

- [ ] **Step 4: Счётчики Blockers/Suggestions в финале**

`extensions/ultra-review/engine.ts`, после судейского блока (перед `const report = lines.join("\n")`) — взять финальный набор находок (kept после судьи или все):

```ts
const judgedFindings = cfg.judge && parsedJudgeOk ? judgeKept : allFindings
```

Для этого в судейском блоке сохранить результат: переменная `judgeKept` и флаг `parsedJudgeOk`:

```ts
let judgeKept: ValidatedFinding[] = []
let parsedJudgeOk = false
...
const judged = applyJudge(parsed, allFindings, ...)
judgeKept = judged.kept
parsedJudgeOk = true
lines.push(...judged.lines)
```

и счётчики (заменить строку с `---` и Consensus — добавить после неё):

```ts
const blockers = finalFindings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL").length
const suggestions = finalFindings.length - blockers
lines.push(`**Blockers:** ${blockers} | **Suggestions:** ${suggestions}`)
```

где `finalFindings = parsedJudgeOk && cfg.judge ? judgeKept : allFindings`.

- [ ] **Step 5: Тесты рендера**

`extensions/ultra-review/engine.test.ts`:

```ts
test("report renders BLOCKER/SUGGESTION tags and rule", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-rule-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["security"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 0, output: 0 } }],
    deep: false,
    judge: false,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async () => ({
      text: `{"context":"FULL","findings":[{"severity":"HIGH","file":"src/a.ts","line":1,"title":"injection","rule":"sql_injection"},{"severity":"LOW","file":"src/a.ts","line":2,"title":"naming"}]}`,
      toolCalls: 1,
      readFiles: ["src/a.ts"],
    }),
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  expect(report).toContain("- [BLOCKER] [HIGH] src/a.ts:1")
  expect(report).toContain("rule: sql_injection")
  expect(report).toContain("- [SUGGESTION] [LOW] src/a.ts:2")
  expect(report).toContain("**Blockers:** 1 | **Suggestions:** 1")
  rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 6: Прогнать тесты — красные**

Run: `bun test`
Expected: новый тест FAIL.

- [ ] **Step 7: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS (существующие ассерты на `(risk: safe, action: delete)` и judge-строки не затронуты).

- [ ] **Step 8: Commit**

```bash
git add extensions/ultra-review/engine.ts extensions/ultra-review/engine.test.ts
git commit -m "feat(review): report renders blocker/suggestion tags, rule, and counts"
```

---

### Task 4: test_integrity — снятие капа тест-файлов

**Files:**
- Modify: `extensions/ultra-review/prompts.ts`
- Test: `extensions/ultra-review/prompts.test.ts`
- Modify: `docs/superpowers/specs/2026-08-08-review-borrowings-design.md`

**Interfaces:**
- Consumes: `buildPrompt(scope, specId, nonce)`.
- Produces: для `test_integrity` в спец-зоне промпта текст, что test-файлы — основной объект и кап MEDIUM не действует.

**Note (уточнение дизайна):** в дизайн-доке механизм был `renderFileMetadata(files, specId?)`. Он ломает shared-prefix тест для скоупов с test-файлами (метаданные — часть общего префикса). Заменяем на текст в спец-зоне промпта (после `# ROLE`) — префикс остаётся общим для всех спеков. Обновить строку в дизайн-доке (Секция 1).

- [ ] **Step 1: Спец-заметка в buildPrompt**

`extensions/ultra-review/prompts.ts`, в `buildPrompt`, в секции `# SPECIALIST SCOPE` (после `renderBullets(spec.ignore)`), добавить:

```ts
${specId === "test_integrity"
  ? `
Note: test files are the primary subject of this review. The usual rule
"kind=test — severity capped at MEDIUM" does NOT apply here: a weakened or
disabled gate is a HIGH/CRITICAL finding regardless of file kind.
`
  : ""}
```

- [ ] **Step 2: Обновить дизайн-док**

`docs/superpowers/specs/2026-08-08-review-borrowings-design.md`, Секция 1, подзаголовок «Кап „test-файлы ≤ MEDIUM" снимается для этого спека» — заменить механизм:

```
renderFileMetadata(files, specId?) → спец-заметка в секции SPECIALIST SCOPE промпта
(test-файлы — основной объект; кап MEDIUM не действует). Общий префикс всех спеков
не ломается (prefix-кэш), shared-prefix тест остаётся зелёным.
```

- [ ] **Step 3: Тест**

`extensions/ultra-review/prompts.test.ts`:

```ts
test("test_integrity prompt lifts the test-file severity cap (tests are the subject)", () => {
  const p = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "test_integrity")
  expect(p).toContain("primary subject of this review")
  expect(p).not.toContain("severity capped at MEDIUM")
  const s = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "security")
  expect(s).toContain("severity capped at MEDIUM")
})

test("shared prefix stays identical across specs even with test files", () => {
  const nonce = "TESTNONCE"
  const scopeWithTest = { files: ["src/a.test.ts"], diff: "+x" }
  const ti = buildPrompt(scopeWithTest, "test_integrity", nonce)
  const sec = buildPrompt(scopeWithTest, "security", nonce)
  expect(ti.slice(0, ti.indexOf("# ROLE"))).toBe(sec.slice(0, sec.indexOf("# ROLE")))
})
```

- [ ] **Step 4: Прогнать тесты — красные**

Run: `bun test`
Expected: новые тесты FAIL (заметки ещё нет).

- [ ] **Step 5: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/ultra-review/prompts.ts extensions/ultra-review/prompts.test.ts docs/superpowers/specs/2026-08-08-review-borrowings-design.md
git commit -m "feat(review): test_integrity lifts test-file severity cap in spec scope (keeps shared prefix)"
```

---

### Task 5: Именованные эвристики в maintainability и style

**Files:**
- Modify: `extensions/ultra-review/prompts.ts`
- Test: `extensions/ultra-review/prompts.test.ts`

**Interfaces:**
- Consumes: `REVIEW_SPECS.maintainability`, `REVIEW_SPECS.style`.
- Produces: обогащённые investigate-списки; новые тесты проверяют наличие формулировок.

- [ ] **Step 1: Эвристики в maintainability**

`extensions/ultra-review/prompts.ts`, массив `investigate` спека `maintainability` — добавить в конец:

```ts
"Cyclomatic complexity above 15 in any method, or lower complexity with opaque path interactions that are hard to reason about.",
"Feature envy: a method uses another class's data or behavior more than its own.",
"Cohesion problems: methods in a class do not share fields or serve one responsibility.",
"Command-query separation violations: a method both mutates state and returns a value.",
"Parse-don't-validate: validation scattered after construction; domain objects can be constructed in an invalid state.",
```

- [ ] **Step 2: Эвристики в style**

`extensions/ultra-review/prompts.ts`, массив `investigate` спека `style` — добавить в конец:

```ts
"X-Out names test: blank out the names (methods, parameters, variables, types) — if the code still reads correctly, the names carry no meaning.",
"Comments that could be replaced by a better name or type: comments stating WHAT or narrating the change.",
```

- [ ] **Step 3: Тесты**

`extensions/ultra-review/prompts.test.ts`:

```ts
test("maintainability prompt documents named heuristics", () => {
  const p = buildPrompt(scope, "maintainability")
  expect(p).toContain("Cyclomatic complexity above 15")
  expect(p).toContain("Feature envy")
  expect(p).toContain("Cohesion problems")
  expect(p).toContain("Command-query separation violations")
  expect(p).toContain("Parse-don't-validate")
})

test("style prompt documents X-Out names test and naming-over-comments", () => {
  const p = buildPrompt(scope, "style")
  expect(p).toContain("X-Out names test")
  expect(p).toContain("better name or type")
})
```

- [ ] **Step 4: Прогнать тесты — красные**

Run: `bun test`
Expected: новые тесты FAIL.

- [ ] **Step 5: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/ultra-review/prompts.ts extensions/ultra-review/prompts.test.ts
git commit -m "feat(review): named heuristics (cyclomatic>15, feature envy, cohesion, CQS, parse-don't-validate, X-Out names)"
```

---

### Task 6: Коммит-история в скоупах и промпте

**Files:**
- Modify: `extensions/ultra-review/types.ts`
- Modify: `extensions/ultra-review/scopes.ts`
- Modify: `extensions/ultra-review/prompts.ts`
- Test: `extensions/ultra-review/scopes.test.ts`, `extensions/ultra-review/prompts.test.ts`

**Interfaces:**
- Consumes: `MAX_COMMIT_CHARS` (Task 1).
- Produces: `Scope.commits?: string`; `getScopes`/`resolveScope` заполняют его для git-скоупов; `buildPrompt` рендерит `# COMMIT HISTORY (untrusted)` в общем префиксе; `encloseDiff(text, nonce?, label?)` принимает label.

- [ ] **Step 1: Тип Scope.commits**

`extensions/ultra-review/types.ts`, `Scope` — добавить поле:

```ts
/** Git-история изменения (для change_quality). Только git-скоупы. */
commits?: string
```

- [ ] **Step 2: encloseDiff принимает label**

`extensions/ultra-review/prompts.ts`:

```ts
export function encloseDiff(text: string, nonce?: string, label = "DIFF"): string {
  const sanitized = sanitizeDiff(text)
  let n = nonce
  if (!n || sanitized.includes(n)) {
    do {
      n = randomUUID().replaceAll("-", "")
    } while (sanitized.includes(n))
  }
  return `BEGIN UNTRUSTED ${label} nonce=${n}\n${sanitized}\nEND UNTRUSTED ${label} nonce=${n}`
}
```

- [ ] **Step 3: truncateCommits**

`extensions/ultra-review/prompts.ts`, рядом с `truncateDiff`:

```ts
/** Обрезка истории коммитов по границам строк (кап MAX_COMMIT_CHARS). */
export function truncateCommits(text: string, maxChars = MAX_COMMIT_CHARS): { text: string; truncated: boolean } {
  const sanitized = sanitizeDiff(text)
  const wasTruncated = sanitized.length > maxChars
  let out = sanitized
  if (wasTruncated) {
    const cut = sanitized.lastIndexOf("\n", maxChars)
    out = sanitized.slice(0, cut === -1 ? maxChars : cut)
  }
  return { text: out, truncated: wasTruncated }
}
```

(импорт `MAX_COMMIT_CHARS` добавить в import из `./constants.ts`)

- [ ] **Step 4: Секция COMMIT HISTORY в buildPrompt**

`extensions/ultra-review/prompts.ts`, в начале `buildPrompt`, после `diffSection`:

```ts
const { text: rawCommits, truncated: commitsTruncated } = truncateCommits(scope.commits ?? "")
const commitSection = rawCommits
  ? `# COMMIT HISTORY (untrusted)\n\n${encloseDiff(redactSecrets(rawCommits), nonce, "COMMIT HISTORY")}${commitsTruncated ? "\n\n⚠ commit history truncated at a line boundary." : ""}`
  : ""
```

в шаблоне после `${diffSection}` вставить `${commitSection}`:

```ts
${diffSection}
${commitSection}

# TRUST BOUNDARY
```

- [ ] **Step 5: Заполнение commits в scopes.ts**

`extensions/ultra-review/scopes.ts` — helper + применение:

```ts
function commitHistory(cwd: string, cmd: string): string | undefined {
  try {
    const out = git(cmd, cwd)
    return out || undefined
  } catch {
    return undefined
  }
}
```

в `getScopes`:
- `working_tree` scope: добавить `commits: commitHistory(cwd, "git log -10 --pretty=format:%h %s")`
- `branch_vs_*` scope: добавить `commits: commitHistory(cwd, `git log --max-count=150 --pretty=format:%h %s%n%b ${base}..HEAD`)`
- `last_commit` scope: добавить `commits: commitHistory(cwd, "git show -s --format=fuller HEAD")`
- `current_dir`: не трогать (нет поля — истории нет)

в `resolveScope`, ветка `last_N_commits`: в синтезированный scope добавить

```ts
commits: commitHistory(cwd, `git log -${m[1]} --pretty=format:%h %s%n%b`),
```

- [ ] **Step 6: Тесты скоупов**

`extensions/ultra-review/scopes.test.ts`:

```ts
test("getScopes: git-скоупы получают коммит-историю, current_dir — нет", () => {
  const scopes = getScopes(repo)
  const byId = Object.fromEntries(scopes.map((s) => [s.id, s]))
  // branch: история A..B с %b (тело сообщения "second").
  expect(byId["branch_vs_origin/main"].commits).toContain("second")
  expect(byId["branch_vs_origin/main"].commits).toContain("%b")
  // last_commit: fuller-вывод содержит автора.
  expect(byId["last_commit"].commits).toContain("Author:")
  // current_dir — истории нет.
  expect(byId["current_dir"].commits).toBeUndefined()
})

test("getScopes: working_tree в грязном дереве получает недавнюю историю", () => {
  const scopes = getScopes(dirty)
  expect(scopes[0].id).toBe("working_tree")
  expect(scopes[0].commits).toContain("init")
})

test("resolveScope: last_N_commits синтезирует историю", () => {
  const scopes = getScopes(repo)
  const s = resolveScope(scopes, "last_2_commits", repo)
  expect(s?.id).toBe("last_2_commits")
  expect(s?.commits).toContain("init")
  expect(s?.commits).toContain("second")
})
```

- [ ] **Step 7: Тесты промпта**

`extensions/ultra-review/prompts.test.ts`:

```ts
test("commit history section rendered when scope.commits present, absent otherwise", () => {
  const withCommits = buildPrompt({ files: ["src/a.ts"], diff: "+x", commits: "abc123 second\n" }, "change_quality")
  expect(withCommits).toContain("# COMMIT HISTORY (untrusted)")
  expect(withCommits).toContain("BEGIN UNTRUSTED COMMIT HISTORY")
  expect(withCommits).toContain("abc123 second")
  const without = buildPrompt({ files: ["src/a.ts"], diff: "+x" }, "change_quality")
  expect(without).not.toContain("# COMMIT HISTORY")
})

test("commit history is truncated at line boundaries (cap)", () => {
  const big = "line1\n" + "x".repeat(25_000) + "\nlast\n"
  const { text, truncated } = truncateCommits(big)
  expect(truncated).toBe(true)
  expect(text.length).toBeLessThanOrEqual(20_000)
  expect(text.endsWith("\n") || text.length === 20_000).toBe(true)
})

test("commit history shares the prefix with other specs (prefix-cache friendly)", () => {
  const nonce = "TESTNONCE"
  const scope = { files: ["src/a.ts"], diff: "+x", commits: "abc123 second\n" }
  const cq = buildPrompt(scope, "change_quality", nonce)
  const sec = buildPrompt(scope, "security", nonce)
  expect(cq.slice(0, cq.indexOf("# ROLE"))).toBe(sec.slice(0, sec.indexOf("# ROLE")))
})
```

- [ ] **Step 8: Прогнать тесты — красные**

Run: `bun test`
Expected: новые тесты FAIL.

- [ ] **Step 9: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS.

- [ ] **Step 10: Commit**

```bash
git add extensions/ultra-review/types.ts extensions/ultra-review/scopes.ts extensions/ultra-review/prompts.ts extensions/ultra-review/scopes.test.ts extensions/ultra-review/prompts.test.ts
git commit -m "feat(review): pass git commit history into scope and prompt (change_quality)"
```

---

### Task 7: Wizard — скрыть change_quality для скоупов без диффа

**Files:**
- Modify: `extensions/ultra-review/wizard.ts`
- Test: `extensions/ultra-review/wizard.test.ts`

**Interfaces:**
- Consumes: `runWizard(ctx, cwd)` — скоуп выбран до специализаций.
- Produces: для `scope.diff === undefined` список специализаций не содержит `change_quality`.

- [ ] **Step 1: Фильтр**

`extensions/ultra-review/wizard.ts`, в `runWizard`, после выбора скоупа:

```ts
// change_quality ревьюит «изменение как целое» — без диффа ей нечего ревьюить.
const allSpecIds = [...SPEC_IDS].filter((s) => s !== "change_quality" || !!scope.diff)
```

(заменяет текущую строку `const allSpecIds = [...SPEC_IDS]`)

- [ ] **Step 2: Тест**

`extensions/ultra-review/wizard.test.ts` — тест по образцу существующего `runWizard: полный флоу` (создать temp-репо без коммитов впереди — только current_dir; ui.select перехватывает вызов выбора специализаций и собирает choices):

```ts
test("runWizard: change_quality скрыт для скоупа без диффа, доступен для скоупа с диффом", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const repo = mkdtempSync(join(tmpdir(), "ur-wiz-cq-"))
  const { execSync } = await import("node:child_process")
  execSync("git init -q -b main", { cwd: repo })
  execSync("git config user.email t@t", { cwd: repo })
  execSync("git config user.name t", { cwd: repo })
  writeFileSync(join(repo, "a.ts"), "const a = 1\n")
  execSync("git add -A && git commit -qm init", { cwd: repo })
  execSync("git branch origin/main", { cwd: repo }) // дифф-скоуп branch_vs_origin/main
  writeFileSync(join(repo, "b.ts"), "const b = 2\n")
  execSync("git add -A && git commit -qm second", { cwd: repo })

  // Прогон 1: diff-less скоуп (current_dir) → change_quality не предлагается.
  let specChoices: string[] = []
  const uiNoDiff = {
    select: async (_title: string, choices: string[]) => {
      if (choices.some((c) => c.startsWith("Current dir"))) return choices.find((c) => c.startsWith("Current dir"))
      if (choices.some((c) => c.startsWith("security:"))) { specChoices = choices; return DONE }
      return undefined
    },
    confirm: async (title: string) => title.startsWith("Deep mode"),
    notify() {},
  }
  const registry = { find: () => undefined, getAll: () => [model("kimi")] }
  await runWizard({ ui: uiNoDiff, modelRegistry: registry } as never, repo)
  expect(specChoices.join("\n")).not.toContain("change_quality")

  // Прогон 2: скоуп с диффом (branch_vs_origin/main) → change_quality доступна.
  const uiWithDiff = {
    select: async (_title: string, choices: string[]) => {
      if (choices.some((c) => c.startsWith("Branch vs"))) return choices.find((c) => c.startsWith("Branch vs"))
      if (choices.some((c) => c.startsWith("security:"))) { specChoices = choices; return DONE }
      return undefined
    },
    confirm: async (title: string) => title.startsWith("Deep mode"),
    notify() {},
  }
  await runWizard({ ui: uiWithDiff, modelRegistry: registry } as never, repo)
  expect(specChoices.join("\n")).toContain("change_quality:")
  rmSync(repo, { recursive: true, force: true })
})
```

> Примечание: выбор специализаций в runWizard идёт в цикле с мультиселектом; первое окно содержит все доступные спеки. Тест перехватывает это окно (наличие `"security:"` в choices) и запоминает его. Оба прогона используют один репо: current_dir (без диффа) и branch_vs_origin/main (с диффом).

- [ ] **Step 3: Прогнать тесты — красные**

Run: `bun test`
Expected: новый тест FAIL.

- [ ] **Step 4: Прогнать тесты — зелёные**

Run: `bun test`
Expected: все PASS (существующий full-flow тест использует скоуп current_dir и не выбирает change_quality — не затронут).

- [ ] **Step 5: Commit**

```bash
git add extensions/ultra-review/wizard.ts extensions/ultra-review/wizard.test.ts
git commit -m "feat(review): hide change_quality in wizard for scopes without a diff"
```

---

### Task 8: README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: имена спеков, поле rule, `MAX_COMMIT_CHARS`.
- Produces: пользовательская документация (по AGENTS.md — просто, без внутренних механизмов).

- [ ] **Step 1: Два направления в списке**

`README.md`, секция «С каких ракурсов идёт ревью» — добавить после блока Simplify:

```markdown
**🧪 Test Integrity — целостность тестов**
Роль: инженер по проверке достоверности тестов. Смотрит, можно ли верить тестам
изменения: не ослаблены ли они ради «зелёного», не подгонялись ли под реализацию,
нет ли тавтологичных проверок, дыр в покрытии нового поведения и тестов,
которые не могут упасть.

**📐 Change Quality — качество изменения**
Роль: инженер, оценивающий изменение целиком. Проверяет связность изменения,
отсутствие посторонних правок, отделение механических правок от смысловых
и чистоту истории коммитов.
```

- [ ] **Step 2: Поле rule и блокеры**

`README.md`, после описания судьи (в разделе «Как это работает») — добавить абзац:

```markdown
Каждая находка в отчёте помечена как **блокер** (обязательно исправить перед
вливанием) или **предложение** (можно отложить). Для важных находок указано,
какое правило нарушено — чтобы было понятно, что именно поправить.
```

- [ ] **Step 3: Константа в таблице конфигурации**

`README.md`, таблица конфигурации — добавить строку после `MAX_DIFF_CHARS`:

```markdown
| `MAX_COMMIT_CHARS` | `20_000` | Сколько текста истории коммитов видит ревьюер |
```

- [ ] **Step 4: Проверка**

Run: прочитать README глазами пользователя — нет ли терминов про промпты, nonce, кэш, контракты.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: test integrity and change quality directions, rule/blocker notes"
```

---

### Task 9: Финальная проверка

**Files:** — (никаких изменений кода)

**Interfaces:** — итоговая сборка всех задач.

- [ ] **Step 1: Полный прогон**

Run: `bun test`
Expected: все PASS (55 + ~20 новых).

- [ ] **Step 2: Проверка консистентности спека (specs.test.ts уже делает)**

Run: `bun test extensions/ultra-review/specs.test.ts`
Expected: PASS — `SPEC_IDS ↔ SPECIALIZATIONS ↔ REVIEW_SPECS` согласованы.

- [ ] **Step 3: Ручной smoke (опционально, нужны модели)**

В temp-репо: ослабить тест (`it.skip` + удалить assert), вызвать `ultra_review` со `specIds: ["test_integrity"]` — ожидается HIGH-находка с `rule`; затем ветка с мусорным коммитом (`feat: x` с правкой трёх несвязанных файлов) — `change_quality` находит несвязанные правки. Проверить в отчёте теги `[BLOCKER]`/`[SUGGESTION]` и блок `**Blockers:** N | **Suggestions:** M`.

- [ ] **Step 4: Проверить git-историю**

Run: `git log --oneline -9`
Expected: 8 коммитов задач + дизайн-коммит, чистое дерево.

---

## Self-Review

- **Спека покрыта:** Секция 1 (test_integrity) → Task 1 + Task 4; Секция 2 (change_quality + engine) → Task 1 + Task 6; Секция 3 (эвристики) → Task 5; Секция 4 (rule) → Task 2 + Task 3; Секция 5 (интеграция: константы/wizard/README/тесты) → Tasks 1, 7, 8, 9.
- **Уточнение дизайна:** механизм кап-исключения перенесён из `renderFileMetadata` в спец-зону промпта — Task 4 и правка дизайн-дока.
- **Типы согласованы:** `ValidatedFinding.rule` (Task 2) используется в рендере (Task 3) и судье (Task 2 Step 4); `Scope.commits` (Task 6) заполняется в `scopes.ts` и читается в `buildPrompt` (Task 6); `MAX_COMMIT_CHARS` (Task 1) используется в `truncateCommits` (Task 6); `encloseDiff` label — единственная точка, все вызовы в `buildPrompt`/`buildJudgePrompt` не меняют сигнатуру.
- **Плейсхолдеров нет:** все шаги содержат конкретный код и ожидаемые результаты.
