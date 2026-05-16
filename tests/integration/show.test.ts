import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("show", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" }],
        });
    });
    afterEach(() => sb.cleanup());

    it("prints group state for an existing group", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["show", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Group: g/);
        assert.match(r.stdout, /api/);
    });

    // Regression: showCommand used to call process.exit(1) directly, which
    // bypassed the main() error formatter. Now it throws like every other
    // command and main() prints the message.
    it("errors cleanly when the group does not exist", () => {
        const r = runMultree(sb, ["show", "never-created"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: never-created/);
    });
});

describe("list", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("prints a friendly message when no groups exist", () => {
        const r = runMultree(sb, ["list"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /No active worktree groups/);
    });

    it("renders a table row per group with name, branch, and repos", () => {
        runMultree(sb, ["create", "first", "--include", "api"]);
        runMultree(sb, ["create", "second", "--include", "frontend"]);
        const r = runMultree(sb, ["list"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /NAME\s+BRANCH/);
        assert.match(r.stdout, /first\s+multree\/first\s+.+\s+api/);
        assert.match(r.stdout, /second\s+multree\/second\s+.+\s+frontend/);
    });

    it("ignores directories under worktree_root that lack .multree.json", () => {
        runMultree(sb, ["create", "real", "--include", "api"]);
        // Plant a sibling directory without a state file -- list must skip it.
        mkdirSync(join(sb.worktreeRoot, "stranger"));
        const r = runMultree(sb, ["list"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /real/);
        assert.doesNotMatch(r.stdout, /stranger/);
    });
});
