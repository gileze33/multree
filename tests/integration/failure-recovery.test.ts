import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, traceThenFail, type Sandbox } from "../helpers/sandbox.ts";

// Recovery: even if a setup hook fails mid-create, state must be persisted so
// destroy can run teardown for every worktree that actually exists on disk.
// This is the bug the test suite was designed to catch.

describe("create that fails partway", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", setup: trace("api:setup") },
                { key: "broken", dirname: "fake-broken", setup: traceThenFail("broken:setup") },
                { key: "later", dirname: "fake-later", setup: trace("later:setup") },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("exits non-zero when a setup hook fails", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api,broken,later"]);
        assert.notEqual(r.status, 0);
    });

    it("persists state for every worktree it managed to create on disk", () => {
        runMultree(sb, ["create", "g", "--include", "api,broken,later"]);

        const state = sb.state("g");
        assert.ok(state, "state file missing after failed create");

        // Worktrees are created up front in a dedicated phase, so all three
        // are persisted. The setup phase records which members succeeded.
        assert.ok(state!.members.api, "api not recorded in state");
        assert.ok(state!.members.broken, "broken not recorded in state");
        assert.ok(state!.members.later, "later not recorded in state");

        assert.equal(state!.members.api.phase_status?.setup, "done");
        assert.equal(state!.members.broken.phase_status?.setup, "failed");
        // `later` never ran setup because the failure halts the phase before
        // launching any further work — its setup status is absent.
        assert.equal(state!.members.later.phase_status?.setup, undefined);

        assert.ok(existsSync(sb.worktreePath("g", "api")), "api worktree missing on disk");
        assert.ok(existsSync(sb.worktreePath("g", "broken")), "broken worktree missing on disk");
        assert.ok(existsSync(sb.worktreePath("g", "later")), "later worktree missing on disk");
    });

    it("destroy runs teardown for every persisted member, including the one whose setup failed", () => {
        // Recreate with teardown hooks attached.
        sb.cleanup();
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup"),
                    teardown: trace("api:teardown"),
                },
                {
                    key: "broken",
                    dirname: "fake-broken",
                    setup: traceThenFail("broken:setup"),
                    teardown: trace("broken:teardown"),
                },
            ],
        });

        runMultree(sb, ["create", "g", "--include", "api,broken"]);
        const r = runMultree(sb, ["destroy", "g"]);
        assert.equal(r.status, 0, r.stderr);

        const events = sb.trace();
        assert.ok(events.includes("api:teardown"), "api teardown should have run");
        assert.ok(events.includes("broken:teardown"), "broken teardown should have run");

        assert.equal(existsSync(sb.worktreePath("g", "api")), false);
        assert.equal(existsSync(sb.worktreePath("g", "broken")), false);
        assert.equal(sb.state("g"), null);
    });
});
