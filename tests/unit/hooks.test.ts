import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
    HookFailureError,
    HookTimeoutError,
    normalizeHook,
    resolveHookTimeout,
    runHook,
} from "../../src/hooks.ts";
import type { MultreeConfig, RepoConfig } from "../../src/types.ts";

describe("normalizeHook", () => {
    it("returns undefined for undefined input", () => {
        assert.equal(normalizeHook(undefined), undefined);
    });

    it("expands a string into {command, cwd: worktree}", () => {
        assert.deepEqual(normalizeHook("pnpm install"), {
            command: "pnpm install",
            cwd: "worktree",
        });
    });

    it("passes through an object form unchanged", () => {
        const obj = { command: "pnpm test", cwd: "repo" as const };
        assert.deepEqual(normalizeHook(obj), obj);
    });

    it("passes through an object form with no explicit cwd", () => {
        const obj = { command: "echo hi" };
        assert.deepEqual(normalizeHook(obj), obj);
    });
});

describe("resolveHookTimeout", () => {
    const config: MultreeConfig = { version: 1, repos: { api: { path: "/x" } } };
    const repoCfg: RepoConfig = { path: "/x" };

    it("returns undefined when no level sets a timeout", () => {
        assert.equal(resolveHookTimeout({ command: "x" }, repoCfg, config), undefined);
    });

    it("prefers a per-hook timeout over per-repo and manifest", () => {
        const cfg: MultreeConfig = { ...config, hook_timeout: "10m" };
        const r: RepoConfig = { ...repoCfg, hooks: { timeout: "5m" } };
        assert.equal(
            resolveHookTimeout({ command: "x", timeout: "1s" }, r, cfg),
            1000,
        );
    });

    it("falls back to repo timeout when per-hook is absent", () => {
        const cfg: MultreeConfig = { ...config, hook_timeout: "10m" };
        const r: RepoConfig = { ...repoCfg, hooks: { timeout: "2s" } };
        assert.equal(resolveHookTimeout({ command: "x" }, r, cfg), 2000);
    });

    it("falls back to manifest timeout when neither is set", () => {
        const cfg: MultreeConfig = { ...config, hook_timeout: 3 };
        assert.equal(resolveHookTimeout({ command: "x" }, repoCfg, cfg), 3000);
    });
});

describe("runHook", () => {
    const cwd = tmpdir();

    it("resolves on a successful hook and reports duration", async () => {
        const r = await runHook("true", cwd);
        assert.equal(typeof r.durationMs, "number");
        assert.ok(r.durationMs >= 0);
    });

    it("rejects with HookFailureError on a non-zero exit", async () => {
        await assert.rejects(
            runHook("exit 3", cwd),
            (err: unknown) => err instanceof HookFailureError && err.exitCode === 3,
        );
    });

    it("captures stdout/stderr when not verbose and surfaces it on failure", async () => {
        await assert.rejects(
            runHook("echo to-stdout; echo to-stderr >&2; exit 1", cwd),
            (err: unknown) => {
                if (!(err instanceof HookFailureError)) {
                    return false;
                }
                return err.output.includes("to-stdout") && err.output.includes("to-stderr");
            },
        );
    });

    it("rejects with HookTimeoutError when the hook outlives the timeout", async () => {
        await assert.rejects(
            runHook("sleep 5", cwd, { timeoutMs: 100 }),
            (err: unknown) => err instanceof HookTimeoutError && err.timeoutMs === 100,
        );
    });
});
