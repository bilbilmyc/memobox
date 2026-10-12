import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** OS 进程内存；不使用基准驱动进程的累计 RSS 冒充被测 MCP 的峰值。 */
export function processMemory(rootPid) {
  if (process.platform === "win32") {
    const shell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = `$ids = @(${Number(rootPid)}); $all = Get-CimInstance Win32_Process; for ($round = 0; $round -lt 5; $round++) { $ids += @($all | Where-Object { $_.ParentProcessId -in $ids } | Select-Object -ExpandProperty ProcessId); $ids = @($ids | Sort-Object -Unique) }; @($ids | ForEach-Object { try { $p = [Diagnostics.Process]::GetProcessById($_); [pscustomobject]@{ pid = $_; rss = $p.WorkingSet64; peak = $p.PeakWorkingSet64 } } catch {} }) | ConvertTo-Json -Compress`;
    const result = spawnSync(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: 15000 },
    );
    if (result.status !== 0) throw Error("OS memory measurement failed");
    const parsed = JSON.parse(result.stdout),
      rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      pids: rows.map((row) => row.pid),
      rssBytes: rows.reduce((sum, row) => sum + row.rss, 0),
      peakBytes: rows.reduce((sum, row) => sum + row.peak, 0),
      processCount: rows.length,
      peakKind:
        "sum of OS process lifetime peaks (parent and current descendants), not necessarily simultaneous",
    };
  }
  const queue = [Number(rootPid)],
    rows = [];
  for (let i = 0; i < queue.length && i < 16; i++) {
    const pid = queue[i];
    if (process.platform === "linux") {
      const path = `/proc/${pid}/status`;
      if (!existsSync(path)) continue;
      const status = readFileSync(path, "utf8"),
        rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
        peak = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      rows.push({ pid, rss, peak });
      try {
        queue.push(
          ...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number),
        );
      } catch {}
    } else {
      const rss = spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      });
      if (rss.status) continue;
      rows.push({
        pid,
        rss: Number(rss.stdout.trim()) * 1024,
        peak: Number(rss.stdout.trim()) * 1024,
      });
      const children = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], {
        encoding: "utf8",
      });
      if (children.status === 0)
        queue.push(...children.stdout.trim().split(/\s+/).map(Number));
    }
  }
  return {
    pids: rows.map((row) => row.pid),
    rssBytes: rows.reduce((sum, row) => sum + row.rss, 0),
    peakBytes: rows.reduce((sum, row) => sum + row.peak, 0),
    processCount: rows.length,
    peakKind:
      process.platform === "linux"
        ? "sum of OS process lifetime VmHWM (parent and current descendants)"
        : "sampled parent/descendant RSS; transient peaks may be missed",
  };
}
