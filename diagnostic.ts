// Стендап-диагностика: прямой вызов zen-relay, повторяющий цикл агента.
import { readFile, readdir } from "node:fs/promises"
import { buildPrompt } from "./extensions/ultra-review/prompts.ts"

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const skip = new Set([".git", "node_modules", ".pi", "reviews", "dist", "build", "coverage", ".venv", "venv", "__pycache__", ".idea", ".next", "target", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".eggs", ".claude", ".ruff_cache"])
  const walk = async (d: string) => {
    let entries: import("node:fs").Dirent[]
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const full = `${d}/${e.name}`
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && !e.isSymbolicLink()) out.push(full.replace(ROOT + "/", "").split("\\").join("/"))
    }
  }
  await walk(dir)
  return out
}

const BASE = "http://127.0.0.1:8765/v1/chat/completions"
const MODEL = "deepseek-v4-flash-free"
const ROOT = "C:/Users/user/Desktop/qwen_talker"

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repository under review. Returns the requested lines with numbers and the file's total line count.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path, e.g. src/engine.ts" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_review",
      description: "Call this to finish the review: pass the COMPLETE final review as a JSON object in the verdict argument. Calling this ends the review.",
      parameters: {
        type: "object",
        properties: { verdict: { type: "string", description: "The complete final review JSON object" } },
        required: ["verdict"],
      },
    },
  },
]

const SYSTEM = [
  "You are reviewing a code repository. You have two tools: read_file(path, startLine?, endLine?) and submit_review(verdict).",
  "Read the files you need with read_file.",
  "When you are confident about the findings, call submit_review with the complete verdict JSON in the verdict argument — NEVER write the JSON in prose.",
  "To submit, emit a tool call exactly like this:",
  '<invoke name="submit_review"><parameter name="verdict" string="true">{"context":"FULL","findings":[]}</parameter></invoke>',
  "You cannot read every file in a large repository. Read a representative sample (a few of the most relevant files), then submit.",
  'read_file calls look like: <invoke name="read_file"><parameter name="path">src/foo.py</parameter></invoke>',
].join("\n")

async function call(messages: unknown[], withTools = true, maxTokens = 4096, retries = 3): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = { model: MODEL, messages, stream: false, max_tokens: maxTokens, temperature: 0.3, reasoning_effort: "low" }
    if (withTools) body.tools = TOOLS
    let res: Response
    try {
      res = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer public" },
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (attempt < retries) {
        console.log("fetch error, retry", attempt + 1)
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      return { status: 0, body: String(e) }
    }
    const txt = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(txt)
    } catch {
      parsed = txt
    }
    if (res.status >= 500 && attempt < retries) {
      console.log(`HTTP ${res.status}, retry ${attempt + 1}`)
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      continue
    }
    return { status: res.status, body: parsed }
  }
}

function textOf(msg: { content?: string | null | Array<{ text?: string }> }): string {
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) return msg.content.map((c) => c.text ?? "").join("\n")
  return ""
}

async function readFileSafely(path: string): Promise<string> {
  try {
    const txt = await readFile(`${ROOT}/${path}`, "utf-8")
    const lines = txt.split("\n")
    return `${path} (${lines.length} lines)\n${lines.slice(0, 300).map((l, i) => `${i + 1}| ${l}`).join("\n")}`
  } catch (e) {
    return `ERROR: read failed: ${(e as Error).message}`
  }
}

async function main() {
  const files = await collectFiles(ROOT)
  const prompt = buildPrompt({ files }, "correctness")
  console.log("PROMPT length:", prompt.length, "files:", files.length)
  const messages: unknown[] = [
    { role: "system", content: prompt },
    { role: "user", content: "Review the files in scope and output your verdict." },
  ]

  for (let round = 0; round < 8; round++) {
    console.log(`\n========== ROUND ${round + 1} ==========`)
    const { status, body } = await call(messages, true)
    console.log("HTTP", status)
    if (status !== 200) {
      console.log("BODY:", JSON.stringify(body).slice(0, 600))
      return
    }
    const b = body as { choices: Array<{ message: Record<string, unknown> }> }
    const msg = b.choices[0].message as { content?: string | null; tool_calls?: unknown[]; reasoning_content?: unknown }
    const text = textOf(msg)
    console.log("--- assistant content ---")
    console.log(text.slice(0, 1500))
    console.log("--- msg keys:", Object.keys(msg).join(","))
    if (msg.tool_calls?.length) {
      console.log("--- STRUCTURED tool_calls ---")
      console.log(JSON.stringify(msg.tool_calls).slice(0, 1200))
    }
    const assistant: Record<string, unknown> = { role: "assistant", content: msg.content ?? "" }
    if (msg.reasoning_content !== undefined && msg.reasoning_content !== null) assistant.reasoning_content = msg.reasoning_content
    if (msg.tool_calls) assistant.tool_calls = msg.tool_calls
    messages.push(assistant)

    const invokes: Array<{ name: string; path: string; id: string }> = []
    const toolMsgs: Array<Record<string, unknown>> = []
    for (const tc of msg.tool_calls ?? []) {
      const t = tc as { id?: string; function?: { name?: string; arguments?: string } }
      try {
        const args = JSON.parse(t.function?.arguments ?? "{}")
        if (t.function?.name === "read_file") {
          invokes.push({ name: "read_file", path: String(args.path ?? ""), id: t.id ?? "" })
        }
      } catch {}
    }
    const textInvokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
    for (const m of text.matchAll(textInvokeRe)) {
      const nm = m[1]
      if (nm === "submit_review") {
        const verdictM = /<parameter\s+name="verdict"[^>]*>([\s\S]*?)<\/parameter>/i.exec(m[2])
        console.log("\n!!! SUBMIT_REVIEW detected, verdict:", (verdictM?.[1] ?? "(none)").slice(0, 600))
        return
      }
      const pathM = /<parameter\s+name="path"[^>]*>([\s\S]*?)<\/parameter>/i.exec(m[2])
      if (nm === "read_file" && pathM) invokes.push({ name: "read_file", path: pathM[1].trim(), id: `text-${round}` })
    }

    if (invokes.length === 0) {
      console.log("\n>>> No tool calls. Model ended with the text above. DONE.")
      return
    }
    console.log(`\n>>> Executing ${invokes.length} read_file calls...`)
    for (const inv of invokes) {
      const res = await readFileSafely(inv.path)
      toolMsgs.push({ role: "tool", tool_call_id: inv.id, name: inv.name, content: res })
    }
    messages.push(...toolMsgs)

    // После 5 раундов чтения — СВЕЖИЙ диалог БЕЗ тулов: влитое содержимое
    // прочитанного + шаблон. Модель без тул-истории может ответить JSON'ом.
    if (round === 1) {
      console.log("\n========== FRESH NO-TOOLS REVIEW CALL ==========")
      const readContents = messages
        .filter((m) => (m as { role?: string }).role === "tool")
        .map((m) => (m as { content?: string }).content ?? "")
        .join("\n\n---\n\n")
        .slice(0, 60_000)
      const freshSystem = [
        "You are a senior code reviewer. Below are file excerpts from a repository.",
        "Produce a review verdict as a single JSON object.",
        "The JSON must be exactly:",
        '{"context":"FULL","findings":[{"severity":"low|medium|high|critical","category":"...","file":"...","line":1,"lineEnd":null,"title":"...","description":"...","evidence":"..."}]}',
        'If there are no issues, return {"context":"FULL","findings":[]}.',
        "Output ONLY the JSON. No tool calls, no prose, no markdown fences.",
      ].join("\n")
      const freshUser = "FILE EXCERPTS (numbered lines):\n\n" + readContents
      const { status: s2, body: b2 } = await call(
        [
          { role: "system", content: freshSystem },
          { role: "user", content: freshUser },
        ],
        false,
        8000,
      )
      console.log("HTTP", s2)
      if (s2 === 200) {
        const m2 = (b2 as { choices: Array<{ message: Record<string, unknown> }> }).choices[0].message as { content?: string | null; tool_calls?: unknown[]; reasoning_content?: unknown }
        console.log("--- fresh assistant content ---")
        console.log(textOf(m2).slice(0, 4000))
        if (m2.tool_calls?.length) console.log("STRUCTURED AGAIN:", JSON.stringify(m2.tool_calls).slice(0, 800))
      } else {
        console.log("BODY:", JSON.stringify(b2).slice(0, 600))
      }
      return
    }
  }
  console.log("\n=== loop budget exhausted ===")
}

main().catch((e) => console.error("FATAL:", e))
