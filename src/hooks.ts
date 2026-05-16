import { spawn } from "child_process";
import { parseDuration } from "./duration.ts";
import type { HookCmd, HookSpec, MultreeConfig, RepoConfig } from "./types.ts";

export function normalizeHook(spec: HookSpec | undefined): HookCmd | undefined {
    if (spec === undefined) {
        return undefined;
    }
    if (typeof spec === "string") {
        return { command: spec, cwd: "worktree" };
    }
    return spec;
}

export interface HookRunOptions {
    timeoutMs?: number;
    verbose?: boolean;
    label?: string; // tag prefixed onto captured/buffered output
}

export interface HookRunResult {
    durationMs: number;
    output: string; // captured stdout+stderr (empty when verbose: true)
}

export class HookTimeoutError extends Error {
    constructor(public readonly timeoutMs: number, public readonly output: string) {
        super(`hook timed out after ${timeoutMs}ms`);
        this.name = "HookTimeoutError";
    }
}

export class HookFailureError extends Error {
    constructor(
        public readonly exitCode: number | null,
        public readonly signal: NodeJS.Signals | null,
        public readonly output: string,
    ) {
        const cause = signal ? `signal ${signal}` : `exit ${exitCode}`;
        super(`hook failed (${cause})`);
        this.name = "HookFailureError";
    }
}

// Run a hook command in a subshell, returning when it completes (or rejecting
// on non-zero exit / timeout). Replaces the older sync `runHook` so we can
// kill long-running hooks and parallelise across repos.
export function runHook(
    command: string,
    cwd: string,
    opts: HookRunOptions = {},
): Promise<HookRunResult> {
    const verbose = opts.verbose ?? false;
    const label = opts.label;
    const start = Date.now();

    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            cwd,
            env: process.env,
            shell: "/bin/bash",
            stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        function prefixWrite(stream: NodeJS.WriteStream, data: Buffer): void {
            if (!label) {
                stream.write(data);
                return;
            }
            const text = data.toString("utf-8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (i === lines.length - 1 && lines[i] === "") {
                    continue;
                }
                stream.write(`[${label}] ${lines[i]}\n`);
            }
        }

        child.stdout?.on("data", (data: Buffer) => {
            if (verbose) {
                prefixWrite(process.stdout, data);
            } else {
                chunks.push(data);
            }
        });
        child.stderr?.on("data", (data: Buffer) => {
            if (verbose) {
                prefixWrite(process.stderr, data);
            } else {
                chunks.push(data);
            }
        });

        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                // Escalate if it doesn't exit promptly.
                setTimeout(() => {
                    if (!child.killed) {
                        child.kill("SIGKILL");
                    }
                }, 2000).unref();
            }, opts.timeoutMs);
            timer.unref();
        }

        child.on("error", err => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(err);
        });

        child.on("close", (code, signal) => {
            if (timer) {
                clearTimeout(timer);
            }
            const output = Buffer.concat(chunks).toString("utf-8");
            const durationMs = Date.now() - start;
            if (timedOut) {
                reject(new HookTimeoutError(opts.timeoutMs ?? 0, output));
                return;
            }
            if (code === 0) {
                resolve({ durationMs, output: verbose ? "" : output });
                return;
            }
            reject(new HookFailureError(code, signal, output));
        });
    });
}

// Resolve which timeout (in ms) applies to a given hook, walking from
// per-hook -> per-repo -> manifest-level. Returns undefined if none set.
export function resolveHookTimeout(
    hook: HookCmd,
    repoCfg: RepoConfig,
    config: MultreeConfig,
): number | undefined {
    const candidates: Array<string | number | undefined> = [
        hook.timeout,
        repoCfg.hooks?.timeout,
        config.hook_timeout,
    ];
    for (const c of candidates) {
        if (c !== undefined) {
            return parseDuration(c);
        }
    }
    return undefined;
}
