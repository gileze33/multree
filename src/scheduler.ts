// Tiny dependency-aware parallel scheduler.
//
// `runScheduled` runs `work` over `items`, with at most `jobs` tasks in flight
// concurrently, in an order that respects `depsOf` (item key -> list of keys
// that must complete first). When an item's dependency fails or is skipped,
// the item is skipped too — its work function is never called. A task that
// throws is recorded as failed; other tasks continue (their dependents may
// then skip), and the final aggregated outcome is returned by the caller.
//
// This is intentionally minimal — no priority queues, no cancellation tokens.
// Callers wanting to abort mid-run pass an AbortSignal through `work` itself.

// Run `work` over `items` with at most `jobs` tasks in flight, returning
// results in input order. Unlike runScheduled this is dependency-free and does
// no failure propagation: every item runs, and a rejection rejects the whole
// pool. For independent read-only fan-outs (e.g. `list` probing every
// worktree's git state) the scheduler's skip-on-failure semantics are wrong —
// one unreadable worktree shouldn't mark its siblings "skipped" — so reach for
// this instead.
export async function mapPool<T, R>(
    items: readonly T[],
    jobs: number,
    work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const limit = Math.max(1, jobs | 0);
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) {
                return;
            }
            results[i] = await work(items[i], i);
        }
    }
    const count = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: count }, () => worker()));
    return results;
}

export type TaskOutcome = "ok" | "failed" | "skipped";

export interface TaskResult {
    key: string;
    outcome: TaskOutcome;
    error?: Error;
    durationMs: number;
}

export interface ScheduleOptions {
    jobs: number;
    depsOf?: Record<string, string[]>;
}

// Returns the first cycle found in the `items` subgraph, as a path
// (e.g. ["a", "b", "a"]), or null if the graph is acyclic. Ignores deps
// pointing outside `items` — the caller is expected to validate those
// separately if needed.
export function detectCycle(
    items: string[],
    depsOf: Record<string, string[]>,
): string[] | null {
    const set = new Set(items);
    const color = new Map<string, "white" | "gray" | "black">();
    for (const key of items) {
        color.set(key, "white");
    }
    let found: string[] | null = null;

    function visit(key: string, stack: string[]): void {
        if (found) {
            return;
        }
        const c = color.get(key);
        if (c === "black") {
            return;
        }
        if (c === "gray") {
            found = [...stack.slice(stack.indexOf(key)), key];
            return;
        }
        color.set(key, "gray");
        for (const dep of depsOf[key] ?? []) {
            if (set.has(dep)) {
                visit(dep, [...stack, key]);
                if (found) {
                    return;
                }
            }
        }
        color.set(key, "black");
    }

    for (const key of items) {
        visit(key, []);
        if (found) {
            return found;
        }
    }
    return null;
}

// Topologically sort `items` so each item appears after its dependencies.
// Throws if a cycle is detected, naming one offending key.
export function topoOrder(items: string[], depsOf: Record<string, string[]>): string[] {
    const cycle = detectCycle(items, depsOf);
    if (cycle) {
        throw new Error(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    }
    const set = new Set(items);
    const seen = new Set<string>();
    const out: string[] = [];
    function visit(key: string): void {
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        for (const dep of depsOf[key] ?? []) {
            if (set.has(dep)) {
                visit(dep);
            }
        }
        out.push(key);
    }
    for (const key of items) {
        visit(key);
    }
    return out;
}

// Run `work(key)` for every key in `items`, respecting depsOf and jobs.
// Resolves with one TaskResult per key, in the order tasks completed.
export async function runScheduled(
    items: string[],
    work: (key: string) => Promise<void>,
    opts: ScheduleOptions,
): Promise<TaskResult[]> {
    const deps = opts.depsOf ?? {};
    // Validate cycles up front (works even when jobs=1).
    const cycle = detectCycle(items, deps);
    if (cycle) {
        throw new Error(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    }

    const jobs = Math.max(1, opts.jobs | 0);
    const results = new Map<string, TaskResult>();
    const remaining = new Set(items);
    const running = new Set<string>();

    function depsSatisfied(key: string): boolean {
        for (const dep of deps[key] ?? []) {
            if (!items.includes(dep)) {
                continue;
            }
            const r = results.get(dep);
            if (!r || r.outcome !== "ok") {
                return false;
            }
        }
        return true;
    }

    function hasFailedOrSkippedDep(key: string): boolean {
        for (const dep of deps[key] ?? []) {
            if (!items.includes(dep)) {
                continue;
            }
            const r = results.get(dep);
            if (r && r.outcome !== "ok") {
                return true;
            }
        }
        return false;
    }

    function pickNext(): string | null {
        for (const key of items) {
            if (!remaining.has(key) || running.has(key)) {
                continue;
            }
            if (hasFailedOrSkippedDep(key)) {
                return key;
            }
            if (depsSatisfied(key)) {
                return key;
            }
        }
        return null;
    }

    return new Promise(resolve => {
        const completed: TaskResult[] = [];
        let anyFailed = false;

        function drainRemainingAsSkipped(): void {
            for (const key of Array.from(remaining)) {
                remaining.delete(key);
                const r: TaskResult = { key, outcome: "skipped", durationMs: 0 };
                results.set(key, r);
                completed.push(r);
            }
        }

        function maybeLaunch(): void {
            while (running.size < jobs) {
                const next = pickNext();
                if (!next) {
                    break;
                }
                remaining.delete(next);
                if (hasFailedOrSkippedDep(next) || anyFailed) {
                    const r: TaskResult = { key: next, outcome: "skipped", durationMs: 0 };
                    results.set(next, r);
                    completed.push(r);
                    continue;
                }
                running.add(next);
                const start = Date.now();
                Promise.resolve()
                    .then(() => work(next))
                    .then(
                        () => {
                            running.delete(next);
                            const r: TaskResult = {
                                key: next,
                                outcome: "ok",
                                durationMs: Date.now() - start,
                            };
                            results.set(next, r);
                            completed.push(r);
                            settleOrLaunch();
                        },
                        err => {
                            running.delete(next);
                            const r: TaskResult = {
                                key: next,
                                outcome: "failed",
                                error: err instanceof Error ? err : new Error(String(err)),
                                durationMs: Date.now() - start,
                            };
                            results.set(next, r);
                            completed.push(r);
                            anyFailed = true;
                            settleOrLaunch();
                        },
                    );
            }
        }

        function settleOrLaunch(): void {
            if (anyFailed && running.size === 0) {
                drainRemainingAsSkipped();
            }
            if (remaining.size === 0 && running.size === 0) {
                resolve(completed);
                return;
            }
            maybeLaunch();
        }

        if (items.length === 0) {
            resolve([]);
            return;
        }
        maybeLaunch();
        if (running.size === 0 && completed.length === items.length) {
            resolve(completed);
        }
    });
}
