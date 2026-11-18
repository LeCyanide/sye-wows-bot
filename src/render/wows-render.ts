/**
 * Vendored from LeCyanide/replay-parser, bindings/node/src/index.ts
 * (@tactics/wows-render), at commit 8466aba (unchanged up to replay-parser
 * main 14a4c36). Vendored rather than a file: dependency so the bot builds on
 * its own; refresh it by copying the file again.
 *
 * One local change: StderrParser's constructor parameter property became a
 * plain field, because `npm run dev` runs this file through Node's type
 * stripping, which cannot erase parameter properties.
 */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

/** Error codes emitted by the CLI. */
export type CliErrorCode =
  | "unsupported_version"
  | "bad_replay"
  | "missing_data"
  | "io"
  | "too_large"
  | "internal";

/** Error codes produced by this wrapper. */
export type WrapperErrorCode = "timeout" | "aborted" | "spawn_failed";

export type RenderErrorCode = CliErrorCode | WrapperErrorCode;

const CLI_CODES: ReadonlySet<string> = new Set<CliErrorCode>([
  "unsupported_version",
  "bad_replay",
  "missing_data",
  "io",
  "too_large",
  "internal",
]);

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  /** Last stderr lines (progress lines excluded), newline separated. */
  readonly stderr: string;
  /** Exit code of the child, if it exited normally. */
  readonly exitCode: number | null;

  constructor(
    code: RenderErrorCode,
    message: string,
    options: { stderr?: string; exitCode?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RenderError";
    this.code = code;
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode ?? null;
  }
}

export type ProgressStage = "parse" | "simulate" | "render" | "encode";

export interface Progress {
  stage: ProgressStage;
  done: number;
  total: number;
}

export interface RenderOptions {
  /** Path to a .wowsreplay file, or the replay bytes (sent over stdin). */
  input: string | Buffer | Uint8Array;
  /** Write the MP4 here. If omitted the MP4 is returned in `result.mp4`. */
  output?: string;
  /** Data directory (defs/, gameparams/, maps/). */
  dataDir: string;
  /**
   * Binary to run: a path/command, or `[command, ...args]` to prepend args.
   * Default: env WOWS_RENDER_BIN, else `wows-render` on PATH.
   */
  binary?: string | readonly string[];
  /** Playback speed against the battle (CLI default 32: a 20-minute battle
   *  becomes 37.5 s). Ignored when `duration` is set. */
  speed?: number;
  /** Fixed video length in seconds instead of a fixed speed. */
  duration?: number;
  /** Size cap for the MP4 in megabytes (10^6 bytes; CLI default 8). */
  maxMb?: number;
  /** Frames per second (CLI default 30). */
  fps?: number;
  /** Pixels (CLI default 1080). */
  width?: number;
  /** Pixels (CLI default 720). */
  height?: number;
  /** Draw the minimap grid (1–10, A–J) over the map. Default true. */
  grid?: boolean;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
  /** Kill the child after this many ms. Default 120000. 0 or Infinity disables. */
  timeoutMs?: number;
}

export interface RenderResult {
  /** Present when no `output` path was given. */
  mp4?: Buffer;
  /** Present when `output` was given. */
  path?: string;
  frames: number;
  bytes: number;
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LINES = 50;
const STDIN_CHUNK = 64 * 1024;
const PROGRESS_STAGES: ReadonlySet<string> = new Set(["parse", "simulate", "render", "encode"]);

interface DoneInfo {
  bytes: number;
  frames: number;
  warnings: string[];
}

/** Incremental parser for the CLI's line-oriented stderr. */
class StderrParser {
  private readonly decoder = new StringDecoder("utf8");
  private buf = "";
  private readonly tail: string[] = [];
  done: DoneInfo | undefined;
  cliError: { code: string; message: string } | undefined;

  private readonly onProgress: ((p: Progress) => void) | undefined;

  constructor(onProgress?: (p: Progress) => void) {
    this.onProgress = onProgress;
  }

  push(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    this.drain(false);
  }

  end(): void {
    this.buf += this.decoder.end();
    this.drain(true);
  }

  tailText(): string {
    return this.tail.join("\n");
  }

  private drain(flush: boolean): void {
    let idx: number;
    while ((idx = this.buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buf.slice(0, idx);
      const sep = this.buf.startsWith("\r\n", idx) ? 2 : 1;
      // A lone trailing "\r" might be the first half of "\r\n"; wait for more.
      if (!flush && sep === 1 && this.buf[idx] === "\r" && idx === this.buf.length - 1) return;
      this.buf = this.buf.slice(idx + sep);
      this.line(line);
    }
    if (flush && this.buf.length > 0) {
      const rest = this.buf;
      this.buf = "";
      this.line(rest);
    }
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("{")) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = undefined;
      }
      if (obj !== null && typeof obj === "object") {
        if (this.handleJson(obj as Record<string, unknown>, line)) return;
      }
    }
    this.keep(line);
  }

  /** Returns true if the line was consumed as a progress event. */
  private handleJson(o: Record<string, unknown>, line: string): boolean {
    const stage = o["stage"];
    if (typeof stage === "string" && PROGRESS_STAGES.has(stage)) {
      const p: Progress = {
        stage: stage as ProgressStage,
        done: Number(o["done"]) || 0,
        total: Number(o["total"]) || 0,
      };
      try {
        this.onProgress?.(p);
      } catch {
        // A throwing callback must not break rendering.
      }
      return true;
    }
    if (stage === "done") {
      const w = o["warnings"];
      this.done = {
        bytes: Number(o["bytes"]) || 0,
        frames: Number(o["frames"]) || 0,
        warnings: Array.isArray(w) ? w.map(String) : [],
      };
      return true;
    }
    const err = o["error"];
    if (err !== null && typeof err === "object") {
      const e = err as Record<string, unknown>;
      this.cliError = {
        code: typeof e["code"] === "string" ? e["code"] : "internal",
        message: typeof e["message"] === "string" ? e["message"] : "unknown error",
      };
    }
    this.keep(line);
    return true;
  }

  private keep(line: string): void {
    this.tail.push(line.length > 2000 ? line.slice(0, 2000) + "..." : line);
    if (this.tail.length > STDERR_TAIL_LINES) this.tail.shift();
  }
}

function resolveBinary(binary: RenderOptions["binary"]): { cmd: string; args: string[] } {
  if (Array.isArray(binary)) {
    const [cmd, ...args] = binary as readonly string[];
    if (!cmd) throw new RenderError("spawn_failed", "binary array must not be empty");
    return { cmd, args };
  }
  if (typeof binary === "string" && binary !== "") return { cmd: binary, args: [] };
  const env = process.env["WOWS_RENDER_BIN"];
  return { cmd: env && env !== "" ? env : "wows-render", args: [] };
}

function buildArgs(opts: RenderOptions, fromStdin: boolean): string[] {
  const args: string[] = [fromStdin ? "-" : (opts.input as string)];
  args.push("--out", opts.output ?? "-", "--data", opts.dataDir);
  const num = (flag: string, v: number | undefined): void => {
    if (v !== undefined) args.push(flag, String(v));
  };
  num("--speed", opts.speed);
  num("--duration", opts.duration);
  num("--max-mb", opts.maxMb);
  num("--fps", opts.fps);
  num("--width", opts.width);
  num("--height", opts.height);
  if (opts.grid === false) args.push("--no-grid");
  args.push("--progress", "json");
  return args;
}

export function renderReplay(opts: RenderOptions): Promise<RenderResult> {
  return new Promise<RenderResult>((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(new RenderError("aborted", "render aborted before start"));
      return;
    }

    let bin: { cmd: string; args: string[] };
    try {
      bin = resolveBinary(opts.binary);
    } catch (e) {
      reject(e);
      return;
    }

    const fromStdin = typeof opts.input !== "string";
    const toStdout = opts.output === undefined;
    const args = [...bin.args, ...buildArgs(opts, fromStdin)];

    const parser = new StderrParser(opts.onProgress);
    const stdoutChunks: Buffer[] = [];
    let spawnErrored = false;
    let killReason: "timeout" | "aborted" | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(bin.cmd, args, {
      shell: false,
      windowsHide: true,
      stdio: [fromStdin ? "pipe" : "ignore", toStdout ? "pipe" : "ignore", "pipe"],
    });

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: RenderError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (r: RenderResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const kill = (reason: "timeout" | "aborted"): void => {
      if (killReason) return;
      killReason = reason;
      child.kill("SIGKILL");
    };
    function onAbort(): void {
      kill("aborted");
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => kill("timeout"), timeoutMs);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Fired for spawn failure (ENOENT, EACCES) and, rarely, kill failure.
      if (child.pid === undefined) {
        spawnErrored = true;
        fail(
          new RenderError("spawn_failed", `failed to spawn "${bin.cmd}": ${err.message}`, {
            cause: err,
          }),
        );
      }
    });

    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => parser.push(c));
    child.stderr?.on("error", () => {});
    child.stdout?.on("error", () => {});

    if (fromStdin && child.stdin) {
      const data = Buffer.from(
        (opts.input as Uint8Array).buffer,
        (opts.input as Uint8Array).byteOffset,
        (opts.input as Uint8Array).byteLength,
      );
      // pipeline honours backpressure; EPIPE (child exited early) is ignored,
      // the exit status / error JSON tells the real story.
      const chunks = (function* (): Generator<Buffer> {
        for (let i = 0; i < data.length; i += STDIN_CHUNK) yield data.subarray(i, i + STDIN_CHUNK);
      })();
      pipeline(Readable.from(chunks, { objectMode: false }), child.stdin).catch(() => {});
    }

    child.on("close", (code, sig) => {
      if (spawnErrored) return;
      parser.end();
      const stderr = parser.tailText();

      if (killReason === "timeout") {
        fail(new RenderError("timeout", `render timed out after ${timeoutMs}ms`, { stderr }));
        return;
      }
      if (killReason === "aborted") {
        fail(new RenderError("aborted", "render aborted", { stderr }));
        return;
      }

      if (code !== 0) {
        const ce = parser.cliError;
        if (ce) {
          const known = CLI_CODES.has(ce.code) ? (ce.code as CliErrorCode) : "internal";
          fail(new RenderError(known, ce.message, { stderr, exitCode: code }));
        } else {
          const how = code === null ? `signal ${sig}` : `code ${code}`;
          fail(
            new RenderError("internal", `wows-render exited with ${how} without an error report`, {
              stderr,
              exitCode: code,
            }),
          );
        }
        return;
      }

      const done = parser.done;
      if (toStdout) {
        const mp4 = Buffer.concat(stdoutChunks);
        succeed({
          mp4,
          frames: done?.frames ?? 0,
          bytes: mp4.length,
          warnings: done?.warnings ?? [],
        });
        return;
      }
      const path = opts.output as string;
      const finish = (bytes: number): void =>
        succeed({ path, frames: done?.frames ?? 0, bytes, warnings: done?.warnings ?? [] });
      if (done) {
        finish(done.bytes);
      } else {
        stat(path).then(
          (s) => finish(s.size),
          (e: unknown) =>
            fail(
              new RenderError("io", `output file missing after successful exit: ${path}`, {
                stderr,
                cause: e,
              }),
            ),
        );
      }
    });
  });
}

/** Lists game versions (e.g. `15_9_0`) that have entity definitions in `dataDir/defs`. */
export async function supportedVersions(dataDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(`${dataDir.replace(/[\\/]+$/, "")}/defs`, { withFileTypes: true });
  } catch (e) {
    throw new RenderError("missing_data", `cannot read defs/ in data dir "${dataDir}"`, {
      cause: e,
    });
  }
  const key = (v: string): number[] => v.split("_").map((n) => Number.parseInt(n, 10) || 0);
  const root = `${dataDir.replace(/[\\/]+$/, "")}/defs`;
  // As the renderer decides: a version directory (or a symlink to one) that
  // holds entities.xml.
  const usable = await Promise.all(
    entries
      // Version keys only (15_9_0); a build-number key serves one build.
      .filter((d) => /^\d+(_\d+)+$/.test(d.name))
      .map(async (d) => {
        try {
          return (await stat(`${root}/${d.name}/entities.xml`)).isFile() ? d.name : null;
        } catch {
          return null;
        }
      }),
  );
  return usable
    .filter((n): n is string => n !== null)
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const diff = (ka[i] ?? 0) - (kb[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
}
