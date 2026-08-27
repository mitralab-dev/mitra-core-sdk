import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

const [repositoryPath, ref = "origin/alpha"] = process.argv.slice(2)

if (!repositoryPath) {
  throw new Error("Usage: npm run snapshot:mcp -- <mitra-mcp-server path> [ref]")
}

const git = (...args) =>
  execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim()

const commit = git("rev-parse", ref)
const paths = git("ls-tree", "-r", "--name-only", ref)
  .split(/\r?\n/u)
  .filter((path) => /^src\/main\/java\/io\/mitralab\/mcp\/tools\/.+Tools\.java$/u.test(path))
  .sort()

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim()
}

function scanJava(source, start, visitor) {
  let state = "code"

  for (let index = start; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    const triple = source.slice(index, index + 3)

    if (state === "line-comment") {
      if (current === "\n") state = "code"
      continue
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "code"
        index += 1
      }
      continue
    }
    if (state === "string") {
      if (current === '"' && source[index - 1] !== "\\") state = "code"
      continue
    }
    if (state === "character") {
      if (current === "'" && source[index - 1] !== "\\") state = "code"
      continue
    }
    if (state === "text-block") {
      if (triple === '"""') {
        state = "code"
        index += 2
      }
      continue
    }

    if (current === "/" && next === "/") {
      state = "line-comment"
      index += 1
      continue
    }
    if (current === "/" && next === "*") {
      state = "block-comment"
      index += 1
      continue
    }
    if (triple === '"""') {
      state = "text-block"
      index += 2
      continue
    }
    if (current === '"') {
      state = "string"
      continue
    }
    if (current === "'") {
      state = "character"
      continue
    }

    const result = visitor(current, index)
    if (result !== undefined) return result
  }

  return undefined
}

function findAnnotationEnd(source, annotation, path) {
  let open = annotation + "@McpTool".length
  while (/\s/u.test(source[open] ?? "")) open += 1
  if (source[open] !== "(") throw new Error(`Cannot find @McpTool arguments in ${path}`)
  let depth = 0
  const end = scanJava(source, open, (character, index) => {
    if (character === "(") depth += 1
    if (character === ")") {
      depth -= 1
      if (depth === 0) return index + 1
    }
    return undefined
  })
  if (end === undefined) throw new Error(`Cannot find the end of @McpTool in ${path}`)
  return end
}

function findPublicMethodStart(source, start, path) {
  const result = scanJava(source, start, (_character, index) => {
    if (
      source.startsWith("public", index) &&
      !/[\w$]/u.test(source[index - 1] ?? "") &&
      !/[\w$]/u.test(source[index + "public".length] ?? "")
    ) {
      return index
    }
    return undefined
  })
  if (result === undefined) throw new Error(`Cannot find public method after @McpTool in ${path}`)
  return result
}

function isJavaReturnType(value) {
  const withoutArraySuffixes = value.replace(/\[\s*\]/gu, "")
  return /^[A-Za-z_$][\w$., ?<>]*$/u.test(withoutArraySuffixes)
}

function splitParameters(value) {
  const parameters = []
  let start = 0
  let angleDepth = 0
  let parenthesisDepth = 0
  let inString = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"' && value[index - 1] !== "\\") inString = !inString
    if (inString) continue
    if (character === "<") angleDepth += 1
    if (character === ">") angleDepth -= 1
    if (character === "(") parenthesisDepth += 1
    if (character === ")") parenthesisDepth -= 1
    if (character === "," && angleDepth === 0 && parenthesisDepth === 0) {
      parameters.push(value.slice(start, index))
      start = index + 1
    }
  }

  const last = value.slice(start)
  if (last.trim()) parameters.push(last)
  return parameters
}

function parseParameter(value, path, methodName) {
  const normalized = normalizeWhitespace(value.replace(/\bfinal\s+/gu, ""))
  const match = normalized.match(/^(.*\S)\s+(\w+)$/u)
  if (!match) throw new Error(`Cannot parse ${path} ${methodName} parameter: ${normalized}`)
  return { type: match[1], name: match[2] }
}

function extractTools(source, path) {
  const tools = []
  let cursor = 0

  while (true) {
    const annotation = source.indexOf("@McpTool", cursor)
    if (annotation === -1) break
    const annotationEnd = findAnnotationEnd(source, annotation, path)
    const absoluteStart = findPublicMethodStart(source, annotationEnd, path)
    const bodyStart = source.indexOf("{", absoluteStart)
    if (bodyStart === -1) throw new Error(`Cannot find method body after @McpTool in ${path}`)
    const header = normalizeWhitespace(source.slice(absoluteStart, bodyStart))
    const method = header.match(/^public\s+(.+?)\s+(\w+)\s*\((.*)\)\s*(?:throws\s+.+)?$/u)
    if (!method) throw new Error(`Cannot parse @McpTool method in ${path}: ${header}`)
    const returnType = normalizeWhitespace(method[1])
    if (!isJavaReturnType(returnType)) {
      throw new Error(`Invalid Java return type in ${path}: ${returnType}`)
    }
    const name = method[2]
    const parameters = splitParameters(method[3]).map((parameter) =>
      parseParameter(parameter, path, name),
    )
    const signature = `${returnType} ${name}(${parameters
      .map(({ type, name: parameterName }) => `${type} ${parameterName}`)
      .join(", ")})`
    tools.push({ name, returnType, parameters, signature })
    cursor = bodyStart + 1
  }

  return tools
}

const classes = paths.map((path) => {
  const source = git("show", `${ref}:${path}`)
  const tools = extractTools(source, path)
  return { name: path.match(/([^/]+)\.java$/u)[1], path, tools }
})

const canonical = classes
  .flatMap(({ name, tools }) => tools.map(({ signature }) => `${name}.${signature}`))
  .join("\n")
const snapshot = {
  contract: "MCP-ALPHA-TOOLS-001",
  source: {
    repository: "mitralab-dev/mitra-mcp-server",
    ref,
    commit,
  },
  extraction: {
    script: "scripts/snapshot-mcp-tools.mjs",
    canonicalForm:
      "One ClassName.returnType toolName(parameterType parameterName, ...) line per @McpTool method in source path order.",
    sha256: createHash("sha256").update(canonical).digest("hex"),
  },
  total: classes.reduce((sum, item) => sum + item.tools.length, 0),
  classes,
}

writeFileSync(
  resolve("contracts/v0.2.0-beta.0/mcp-alpha-tools.json"),
  `${JSON.stringify(snapshot, null, 2)}\n`,
)
