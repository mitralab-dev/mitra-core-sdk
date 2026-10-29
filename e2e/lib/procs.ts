// Every process the battery starts goes through here, so every one of them dies with it: on the
// end of the run, on Ctrl+C, on SIGTERM and on a timeout. On Windows a killed parent leaves its
// children running (a stopped agent once left batteries hitting the shared dev for hours), so a
// child is killed with its whole tree.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"

const live = new Set<ChildProcess>()
let installed = false

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
}

export function killAll(): void {
  for (const child of live) killTree(child)
  live.clear()
}

export function installCleanup(onSignal?: (signal: string) => void): void {
  if (installed) return
  installed = true
  const die = (signal: NodeJS.Signals, code: number) => {
    process.on(signal, () => {
      onSignal?.(signal)
      killAll()
      process.exit(code)
    })
  }
  die("SIGINT", 130)
  die("SIGTERM", 143)
  if (process.platform !== "win32") die("SIGHUP", 129)
  process.on("exit", killAll)
  process.on("uncaughtException", (e) => {
    killAll()
    console.error(e)
    process.exit(1)
  })
}

/** Starts a child that the cleanup knows about. On POSIX it leads its own group, for killTree. */
export function track(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args, { detached: process.platform !== "win32", ...options })
  live.add(child)
  child.once("exit", () => live.delete(child))
  return child
}

// .cmd shims (npm, aws on some installs) only start through a shell on Windows since Node 20.
const quote = (a: string) => (/[\s"&|<>^%()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs a command to the end and collects what it printed; kills its tree past the timeout. */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  const windows = process.platform === "win32"
  const child = windows
    ? track([command, ...args].map(quote).join(" "), [], {
        shell: true,
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
      })
    : track(command, args, { cwd: options.cwd, env: options.env ?? process.env })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
  if (options.input !== undefined) child.stdin?.end(options.input)
  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        killTree(child)
      }, options.timeoutMs)
    : null
  return new Promise((resolve) => {
    const done = (code: number | null) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    child.once("error", (e) => {
      stderr += String(e)
      done(null)
    })
    child.once("close", done)
  })
}
