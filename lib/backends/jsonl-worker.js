import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class JsonlWorker {
    proc = null;
    rl = null;
    nextId = 1;
    pending = new Map();
    stderrTail = "";
    options;
    constructor(options) {
        this.options = options;
    }
    get isRunning() {
        return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
    }
    async start() {
        if (this.isRunning)
            return;
        const child = spawn(this.options.command, this.options.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...this.options.env },
            windowsHide: true,
        });
        this.proc = child;
        this.stderrTail = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-2000);
        });
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.rl = rl;
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{"))
                return;
            try {
                const msg = JSON.parse(trimmed);
                const id = typeof msg.id === "number" ? msg.id : -1;
                const waiter = this.pending.get(id);
                if (!waiter)
                    return;
                this.pending.delete(id);
                clearTimeout(waiter.timer);
                if (msg.ok === false || typeof msg.error === "string") {
                    waiter.reject(new Error(String(msg.error ?? "Native bridge request failed")));
                }
                else {
                    waiter.resolve(msg);
                }
            }
            catch {
                // Ignore non-JSON diagnostic lines if any
            }
        });
        const failAll = (reason) => {
            const detail = this.stderrTail.trim();
            const err = new Error(detail ? `${reason}: ${detail}` : reason);
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(err);
            }
            this.pending.clear();
        };
        child.on("error", (err) => {
            failAll(`Native worker spawn error (${this.options.command}): ${err.message}`);
        });
        child.on("close", (code) => {
            this.proc = null;
            this.rl = null;
            if (this.pending.size > 0) {
                failAll(`Native worker exited unexpectedly (code=${code ?? "null"})`);
            }
        });
    }
    async request(payload, timeoutMs) {
        if (!this.isRunning) {
            await this.start();
        }
        if (!this.proc || !this.proc.stdin.writable) {
            throw new Error(`Native worker "${this.options.command}" is not writable.`);
        }
        const id = this.nextId++;
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 10_000;
        const line = `${JSON.stringify({ id, ...payload })}\n`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Native worker request "${String(payload.op ?? "unknown")}" timed out after ${timeout}ms.`));
            }, timeout);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(line, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }
    async stop() {
        if (!this.proc)
            return;
        const child = this.proc;
        this.proc = null;
        this.rl?.close();
        this.rl = null;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error("Native worker stopped."));
        }
        this.pending.clear();
        try {
            child.stdin.end();
        }
        catch {
            // ignore
        }
        child.kill();
    }
}
