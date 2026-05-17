import { strict as assert } from "node:assert";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

    // Regression: `multree destroy .` used to resolve to `<worktree_root>/.`
    // and (when any state file existed at that path) recursively rmSync the
    // entire worktree root, taking every sibling group with it.
    it("refuses 'destroy .' and leaves sibling groups intact", () => {
        // A real group worth protecting.
        const create = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(create.status, 0, create.stderr);
        const gStatePath = join(sb.worktreeRoot, "g", ".multree.json");
        assert.ok(existsSync(gStatePath), "precondition: group g state file exists");

        // Plant a stray state file at the worktree root itself. This can
        // happen if a user renames a group dir, an editor saves a backup,
        // or a buggy older version of the tool wrote there once. Without
        // input validation, loadGroup(".") reads it and destroy proceeds.
        const strayState = join(sb.worktreeRoot, ".multree.json");
        writeFileSync(
            strayState,
            JSON.stringify({
                name: ".",
                branch: "stray",
                created_at: "2026-05-17T00:00:00Z",
                members: {},
            }),
        );

        const destroy = runMultree(sb, ["destroy", "."]);
        assert.notEqual(destroy.status, 0, "destroy . must not succeed");
        assert.match(destroy.stderr, /Invalid group name/);

        // The worktree root and the sibling group must survive untouched.
        assert.ok(existsSync(sb.worktreeRoot), "worktree root must survive");
        assert.ok(existsSync(gStatePath), "sibling group g must survive");
        assert.ok(
            existsSync(sb.worktreePath("g", "api")),
            "sibling group's worktree must survive",
        );
    });

    // Regression: `multree destroy ..` resolved to `<worktree_root>/..` =
    // the sandbox root, which the tool would then attempt to rmSync.
    it("refuses 'destroy ..' and leaves the parent of the worktree root intact", () => {
        const parent = dirname(sb.worktreeRoot);
        // A canary file outside the worktree root that must not be touched.
        const canary = join(parent, "canary.txt");
        writeFileSync(canary, "do not delete me");

        const destroy = runMultree(sb, ["destroy", ".."]);
        assert.notEqual(destroy.status, 0, "destroy .. must not succeed");
        assert.match(destroy.stderr, /Invalid group name/);

        assert.ok(existsSync(parent), "parent of worktree root must survive");
        assert.ok(existsSync(canary), "canary file outside the root must survive");
        assert.ok(existsSync(sb.worktreeRoot), "worktree root must survive");
    });

    // Same defensive check for show/status/etc., which also flow through
    // groupDir/loadGroup. Quick smoke check on `show .`.
    it("refuses 'show .' with the same validation error", () => {
        const r = runMultree(sb, ["show", "."]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Invalid group name/);
    });
});
