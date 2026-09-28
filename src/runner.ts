/**
 * Process execution for experiments, checks, and git.
 */

import * as path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

/** Rolling buffer / temp-file threshold for streamed output. */
export const STREAM_MAX_BYTES = 50 * 1024;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/** Kill a process tree (best effort, tries the process group first). */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited
    }
  }
}

/** Run a command to completion, collecting stdout/stderr separately. */
export function exec(
  command: string,
  args: string[],
  opts: { cwd: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));

    const timer = opts.timeout
      ? setTimeout(() => {
          killed = true;
          if (child.pid) killTree(child.pid);
        }, opts.timeout)
      : undefined;
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const done = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      resolve({ code, stdout, stderr, killed });
    });
  });
}

export interface StreamedRun {
  exitCode: number | null;
  timedOut: boolean;
  /** Tail of combined stdout+stderr (rolling buffer, up to 2 × STREAM_MAX_BYTES). */
  output: string;
  /** Full output on disk when it overflowed the rolling buffer. */
  fullOutputPath: string | undefined;
  totalBytes: number;
}

/**
 * Run `bash -c command` with a timeout, streaming combined output into a
 * rolling tail buffer. Output beyond STREAM_MAX_BYTES is also written to a
 * temp file so nothing is lost. `onTick` fires once a second while running.
 */
export function runStreamed(
  command: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onTick?: (tail: string) => void;
  },
): Promise<StreamedRun> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn("bash", ["-c", command], { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    let totalBytes = 0;
    let tempPath: string | undefined;
    let tempStream: WriteStream | undefined;

    const onData = (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > STREAM_MAX_BYTES && !tempStream) {
        tempPath = path.join(tmpdir(), `opencode-experiment-${randomBytes(8).toString("hex")}.log`);
        tempStream = createWriteStream(tempPath);
        for (const chunk of chunks) tempStream.write(chunk);
      }
      tempStream?.write(data);

      chunks.push(data);
      chunksBytes += data.length;
      while (chunksBytes > STREAM_MAX_BYTES * 2 && chunks.length > 1) {
        chunksBytes -= chunks.shift()!.length;
      }
      // Trim the first surviving chunk to a line boundary so a multi-byte
      // character split across chunks never decodes to U+FFFD.
      if (chunksBytes > STREAM_MAX_BYTES * 2) {
        const nl = chunks[0].indexOf(0x0a);
        if (nl !== -1 && nl < chunks[0].length - 1) {
          chunks[0] = chunks[0].subarray(nl + 1);
          chunksBytes -= nl + 1;
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const tick = opts.onTick
      ? setInterval(() => opts.onTick!(Buffer.concat(chunks).toString("utf-8")), 1000)
      : undefined;
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid) killTree(child.pid);
          }, opts.timeoutMs)
        : undefined;
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else {
        child.kill();
        child.once("spawn", () => child.pid && killTree(child.pid));
      }
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (tick) clearInterval(tick);
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      tempStream?.end();
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      resolve({
        exitCode: code,
        timedOut,
        output: Buffer.concat(chunks).toString("utf-8"),
        fullOutputPath: tempPath,
        totalBytes,
      });
    });
  });
}
