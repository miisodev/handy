import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLinuxClipboard } from "../src/backends/linux-cli.js";
import { JsonlWorker } from "../src/backends/jsonl-worker.js";

/**
 * A write to a child process whose stdin has already closed surfaces as EPIPE on the stdin
 * *stream*. Node throws a stream `'error'` event that has no listener as an uncaught exception,
 * so before these handlers existed a broken clipboard helper or native bridge took the entire
 * MCP server process down with it — a silent crash, not a rejected promise.
 *
 * Each test installs an `uncaughtException` listener that fails the test, so a regression shows
 * up as a clear assertion rather than as the test runner losing its worker.
 */
function guardAgainstUncaughtExceptions(onUncaught: (err: Error) => void): () => void {
  process.on("uncaughtException", onUncaught);
  return () => process.off("uncaughtException", onUncaught);
}

describe("Child-process stdin EPIPE must reject, never crash the host process", () => {
  it("JsonlWorker survives a bridge that exits before draining stdin", async () => {
    const uncaught: Error[] = [];
    const removeGuard = guardAgainstUncaughtExceptions((e) => uncaught.push(e));

    // Cross-platform stand-in for a native bridge that dies immediately: the real process exits
    // at once, so the pipe is genuinely closed by the time the request is written.
    const worker = new JsonlWorker({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      requestTimeoutMs: 3000,
    });

    try {
      await worker.start();
      await new Promise((r) => setTimeout(r, 300));

      // Large enough that the write cannot be absorbed by the pipe buffer.
      await expect(worker.request({ op: "probe", payload: "y".repeat(200_000) })).rejects.toThrow();

      expect(uncaught).toEqual([]);
      expect(worker.isRunning).toBe(false);

      // The worker must be restartable rather than wedged in a half-dead state.
      const revived = new JsonlWorker({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({id:1,ok:true})+'\\n'); setTimeout(()=>{},200);"],
        requestTimeoutMs: 3000,
      });
      try {
        const res = await revived.request({ op: "ping" });
        expect(res.ok).toBe(true);
      } finally {
        await revived.stop();
      }
      expect(uncaught).toEqual([]);
    } finally {
      removeGuard();
      await worker.stop();
    }
  });

  it.skipIf(process.platform === "win32")(
    "writeLinuxClipboard survives a clipboard helper that exits without reading stdin",
    async () => {
      const uncaught: Error[] = [];
      const removeGuard = guardAgainstUncaughtExceptions((e) => uncaught.push(e));

      const binDir = mkdtempSync(join(tmpdir(), "handy-fake-bin-"));
      const prevPath = process.env.PATH;
      const prevWayland = process.env.WAYLAND_DISPLAY;

      try {
        // Stands in for wl-copy with no compositor attached: prints a diagnostic and exits 1
        // without ever reading stdin.
        const helper = join(binDir, "wl-copy");
        writeFileSync(helper, '#!/bin/sh\necho "Error: no compositor" >&2\nexit 1\n');
        chmodSync(helper, 0o755);

        process.env.PATH = binDir + delimiter + (prevPath ?? "");
        process.env.WAYLAND_DISPLAY = "wayland-1";

        // Far beyond the 64KB pipe buffer, so the write cannot complete into a closed pipe.
        await expect(writeLinuxClipboard("x".repeat(400_000))).rejects.toThrow(/no compositor/i);

        expect(uncaught).toEqual([]);
      } finally {
        removeGuard();
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
        if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
        else process.env.WAYLAND_DISPLAY = prevWayland;
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "writeLinuxClipboard still succeeds when the helper does read stdin",
    async () => {
      const binDir = mkdtempSync(join(tmpdir(), "handy-fake-bin-ok-"));
      const outFile = join(binDir, "received.txt");
      const prevPath = process.env.PATH;
      const prevWayland = process.env.WAYLAND_DISPLAY;

      try {
        // A helper that drains stdin and exits 0 must resolve, proving the new error handling did
        // not turn the success path into a rejection.
        const helper = join(binDir, "wl-copy");
        writeFileSync(helper, `#!/bin/sh\ncat > ${JSON.stringify(outFile)}\nexit 0\n`);
        chmodSync(helper, 0o755);

        process.env.PATH = binDir + delimiter + (prevPath ?? "");
        process.env.WAYLAND_DISPLAY = "wayland-1";

        await expect(writeLinuxClipboard("clipboard payload")).resolves.toBeUndefined();
        expect(readFileSync(outFile, "utf8")).toBe("clipboard payload");
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
        if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
        else process.env.WAYLAND_DISPLAY = prevWayland;
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );
});
