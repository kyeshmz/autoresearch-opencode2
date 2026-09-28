/**
 * Dashboards: a markdown summary table (shown in the session transcript) and
 * a live browser dashboard served from localhost (`/autoresearch export`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  currentResults,
  findBaselineRunNumber,
  findBaselineSecondary,
  formatNum,
  isBetter,
  type ExperimentState,
} from "./experiment.ts";
import { extractAutoresearchSessionName } from "./jsonl.ts";
import { sessionFilePath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Markdown dashboard
// ---------------------------------------------------------------------------

function pct(value: number, base: number): string {
  const p = ((value - base) / base) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render the current segment as a markdown summary plus a results table. */
export function renderDashboardMarkdown(st: ExperimentState, maxRows = 0): string {
  const title = `## 🔬 autoresearch${st.name ? `: ${st.name}` : ""}`;
  if (st.results.length === 0) return `${title}\n\nNo experiments yet.`;

  const cur = currentResults(st.results, st.currentSegment);
  const count = (status: string) => cur.filter((r) => r.status === status).length;
  const baseline = st.bestMetric;
  const baselineRun = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  let bestPrimary: number | null = null;
  let bestRun = 0;
  for (let i = 0; i < st.results.length; i++) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment || r.status !== "keep" || r.metric <= 0) continue;
    if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
      bestPrimary = r.metric;
      bestRun = i + 1;
    }
  }

  const lines: string[] = [title, ""];
  const summary = [`**Runs:** ${st.results.length}`, `**Kept:** ${count("keep")}`];
  if (count("discard")) summary.push(`**Discarded:** ${count("discard")}`);
  if (count("crash")) summary.push(`**Crashed:** ${count("crash")}`);
  if (count("checks_failed")) summary.push(`**Checks failed:** ${count("checks_failed")}`);
  if (st.confidence !== null) summary.push(`**Confidence:** ${st.confidence.toFixed(1)}×`);
  lines.push(summary.join(" | "));
  lines.push(
    `**Baseline:** ★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineRun ? ` (#${baselineRun})` : ""}`,
  );
  if (bestPrimary !== null) {
    const delta = baseline !== null && baseline !== 0 && bestPrimary !== baseline ? `, ${pct(bestPrimary, baseline)}` : "";
    lines.push(`**Best:** ★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)} (#${bestRun}${delta})`);
  }
  lines.push("");

  const startIdx = maxRows > 0 ? Math.max(0, st.results.length - maxRows) : 0;
  const rows = st.results.slice(startIdx);
  const secMetrics = st.secondaryMetrics.filter((sm) => rows.some((r) => (r.metrics ?? {})[sm.name] !== undefined));

  lines.push(
    `| # | commit | ★ ${cell(st.metricName)} | ${secMetrics.map((sm) => `${cell(sm.name)} | `).join("")}status | description |`,
  );
  lines.push(`|---|---|---|${secMetrics.map(() => "---|").join("")}---|---|`);
  if (startIdx > 0) lines.push(`| … | | ${startIdx} earlier run${startIdx === 1 ? "" : "s"} |${secMetrics.map(() => " |").join("")} | |`);

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);
  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    let primary = formatNum(r.metric, st.metricUnit);
    if (!isOld && i !== baselineIndex && baseline !== null && baseline !== 0 && r.metric > 0) {
      primary += ` (${pct(r.metric, baseline)})`;
    }
    const commit = isOld ? "(old)" : r.status === "keep" ? `\`${r.commit}\`` : "—";
    const secCells = secMetrics.map((sm) => {
      const val = (r.metrics ?? {})[sm.name];
      if (val === undefined) return "—";
      const bv = baselineSec[sm.name];
      const delta = !isOld && i !== baselineIndex && bv !== undefined && bv !== 0 && val !== bv ? ` (${pct(val, bv)})` : "";
      return formatNum(val, sm.unit) + delta;
    });
    const revisits = r.asi?.revisits_run;
    const revisitNote = typeof revisits === "number" && Number.isInteger(revisits) && revisits > 0 ? ` ↻ #${revisits}` : "";
    lines.push(
      `| ${i + 1} | ${commit} | ${primary} | ${secCells.map((c) => `${c} | `).join("")}${r.status} | ${cell(r.description)}${revisitNote} |`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Live browser dashboard
// ---------------------------------------------------------------------------

const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function logoDataUrl(): string {
  const bytes = fs.readFileSync(path.join(packageRoot, "assets/logo.webp"));
  return `data:image/webp;base64,${bytes.toString("base64")}`;
}

function openInBrowser(url: string): void {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, shell: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  // Launcher errors (e.g. xdg-open missing) are fine — the caller shows the URL.
  child.on("error", () => {});
  child.unref();
}

export function createDashboardServer() {
  let server: Server | null = null;
  let port: number | null = null;
  let servedWorkDir: string | null = null;
  let htmlPath: string | null = null;
  const sseClients = new Set<ServerResponse>();

  const stop = (): void => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {}
    }
    sseClients.clear();
    try {
      server?.close();
    } catch {}
    server = null;
    port = null;
    servedWorkDir = null;
    htmlPath = null;
  };

  const writeHtml = (workDir: string): string => {
    const jsonl = fs.readFileSync(sessionFilePath(workDir, "log"), "utf-8").trim();
    const title = escapeHtml(extractAutoresearchSessionName(jsonl));
    const html = fs
      .readFileSync(path.join(packageRoot, "assets/template.html"), "utf-8")
      .replace(TITLE_PLACEHOLDER, () => title)
      .replace(LOGO_PLACEHOLDER, () => logoDataUrl());
    const dest = path.join(fs.mkdtempSync(path.join(tmpdir(), "opencode-autoresearch-dashboard-")), "index.html");
    fs.writeFileSync(dest, html);
    return dest;
  };

  const listen = (workDir: string): Promise<number> =>
    new Promise((resolve, reject) => {
      if (server && servedWorkDir === workDir && port) {
        resolve(port);
        return;
      }
      stop();
      const next = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write("retry: 1000\n\n");
          sseClients.add(res);
          res.on("close", () => sseClients.delete(res));
          return;
        }
        const file =
          url.pathname === "/" ? htmlPath : url.pathname === "/autoresearch.jsonl" ? sessionFilePath(workDir, "log") : null;
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        fs.readFile(file, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          });
          res.end(data);
        });
      });
      next.on("error", reject);
      next.listen(0, "127.0.0.1", () => {
        const address = next.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind dashboard server"));
          return;
        }
        server = next;
        port = address.port;
        servedWorkDir = workDir;
        resolve(address.port);
      });
    });

  return {
    stop,

    /** Notify connected browsers that the log changed. */
    broadcast(workDir: string): void {
      if (!server || servedWorkDir !== workDir) return;
      for (const res of sseClients) {
        try {
          res.write(`event: jsonl-updated\ndata: ${Date.now()}\n\n`);
        } catch {
          sseClients.delete(res);
        }
      }
    },

    /** Serve the dashboard for workDir, open it in a browser (unless `launch` is false), and return its URL. */
    async open(workDir: string, launch = true): Promise<string> {
      const resolved = path.resolve(workDir);
      const nextHtml = writeHtml(resolved);
      const listeningPort = await listen(resolved);
      htmlPath = nextHtml;
      const url = `http://127.0.0.1:${listeningPort}`;
      if (launch) openInBrowser(url);
      return url;
    },
  };
}
