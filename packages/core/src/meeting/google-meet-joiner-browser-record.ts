import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso } from "./google-meet-joiner-base.ts";

export function createActiveBrowserRecord(activeBrowserPath: string) {
  async function clear() {
    await unlink(activeBrowserPath).catch(() => {});
  }

  async function remember(browser, sessionId, meetUrl) {
    const pid = typeof browser?.process === "function" ? browser.process()?.pid : 0;
    if (!pid) return { ok: false, reason: "browser_pid_unavailable" };
    await mkdir(dirname(activeBrowserPath), { recursive: true });
    await writeFile(
      activeBrowserPath,
      `${JSON.stringify(
        {
          pid,
          sessionId,
          meetUrl,
          createdAt: nowIso(),
        },
        null,
        2,
      )}\n`,
    );
    return { ok: true, pid, path: activeBrowserPath };
  }

  async function stop(reason = "replace_existing_bot") {
    let record;
    try {
      record = JSON.parse(await readFile(activeBrowserPath, "utf8"));
    } catch {
      return { ok: true, stopped: false, reason, source: "record_absent" };
    }
    const pid = Number(record.pid || 0);
    if (!pid || pid === process.pid) {
      await clear();
      return { ok: true, stopped: false, reason, source: "record_invalid" };
    }
    try {
      process.kill(pid, 0);
    } catch {
      await clear();
      return {
        ok: true,
        stopped: false,
        reason,
        source: "process_absent",
        pid,
        sessionId: record.sessionId || "",
      };
    }
    try {
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process exited after SIGTERM.
      }
      await clear();
      return {
        ok: true,
        stopped: true,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
      };
    } catch (error) {
      return {
        ok: false,
        stopped: false,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
        error: String(error?.message || error),
      };
    }
  }

  return { clear, remember, stop };
}
