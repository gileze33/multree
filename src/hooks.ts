import { spawn } from "child_process";
import { formatDuration, parseDuration } from "./duration.ts";
import type { HookCmd, HookSpec, MultreeConfig, RepoConfig } from "./types.ts";

export type MemberHookPhase = "install" | "setup" | "teardown";

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
    // Extra env vars layered on top of process.env when the hook spawns. Used
    // by runMemberHook to surface the group name (MULTREE_NAME) so setup /
    // teardown scripts can derive their own worktree-scoped identifiers from
    // it instead of inventing one.
    extraEnv?: Record<string, string>;
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
            env: opts.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env,
            shell: "bash",
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

export interface MemberHookArgs {
    phase: MemberHookPhase;
    repoName: string;
    // Group the hook is running for; surfaced to the spawned process as
    // MULTREE_NAME so setup / teardown scripts can derive their own
    // worktree-scoped identifiers from it.
    groupName: string;
    hook: HookCmd;
    repoPath: string;
    worktreePath: string;
    repoCfg: RepoConfig;
    config: MultreeConfig;
    // Only consulted for install/setup; teardown always streams live so the
    // user can see what's happening as a worktree comes down.
    verbose?: boolean;
}

// One entry point for "run a hook attached to a member of a group". Centralises
// cwd resolution, timeout lookup, the [<repo>] log prefix, and the post-failure
// captured-output dump. Failure semantics differ by phase:
//   - install/setup: rethrows on failure; callers decide what to do (create
//     marks the member failed in state; add unwinds back to the user).
//   - teardown:      catches HookFailureError/HookTimeoutError and logs, so
//     `remove`/`destroy` can finish tearing the worktree down regardless.
export async function runMemberHook(args: MemberHookArgs): Promise<HookRunResult | undefined> {
    const { phase, repoName, groupName, hook, repoPath, worktreePath, repoCfg, config } = args;
    const cwd = hook.cwd === "repo" ? repoPath : worktreePath;
    const timeoutMs = resolveHookTimeout(hook, repoCfg, config);
    const fatal = phase !== "teardown";
    const verbose = phase === "teardown" ? true : (args.verbose ?? false);

    console.log(`[${repoName}] ${phase} hook${timeoutMs ? ` (timeout: ${timeoutMs}ms)` : ""}`);
    if (!verbose) {
        console.log(`  $ (${cwd}) ${hook.command}`);
    }

    try {
        const r = await runHook(hook.command, cwd, {
            timeoutMs,
            verbose,
            label: verbose ? repoName : undefined,
            extraEnv: { MULTREE_NAME: groupName },
        });
        console.log(`[${repoName}] ${phase} hook done in ${formatDuration(r.durationMs)}`);
        return r;
    } catch (err) {
        if (!verbose && (err instanceof HookFailureError || err instanceof HookTimeoutError) && err.output) {
            process.stderr.write(err.output);
            if (!err.output.endsWith("\n")) {
                process.stderr.write("\n");
            }
        }
        if (fatal) {
            throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${repoName}] ${phase} failed: ${msg}`);
        return undefined;
    }
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
