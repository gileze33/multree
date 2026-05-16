import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("destroy edge cases", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup"),
                    teardown: trace("api:teardown"),
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    setup: trace("frontend:setup"),
                    teardown: trace("frontend:teardown"),
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("a second destroy on the same group errors cleanly", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const first = runMultree(sb, ["destroy", "g"]);
        assert.equal(first.status, 0, first.stderr);

        const second = runMultree(sb, ["destroy", "g"]);
        assert.notEqual(second.status, 0);
        assert.match(second.stderr, /Group not found: g/);
    });

    it("destroy succeeds even when one member's worktree was deleted out of band", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);

        // Simulate the user blowing away one worktree manually.
        rmSync(sb.worktreePath("g", "api"), { recursive: true, force: true });
        assert.equal(existsSync(sb.worktreePath("g", "api")), false);

        const r = runMultree(sb, ["destroy", "g"]);
        assert.equal(r.status, 0, `destroy should clean up the rest\n${r.stderr}`);

        assert.equal(existsSync(sb.worktreePath("g", "frontend")), false);
        assert.equal(sb.state("g"), null);

        const events = sb.trace();
        assert.ok(events.includes("frontend:teardown"));
    });

    it("destroy on a non-existent group errors with a clear message", () => {
        const r = runMultree(sb, ["destroy", "never-created"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: never-created/);
    });
});
