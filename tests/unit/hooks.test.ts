import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizeHook } from "../../src/hooks.ts";

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
