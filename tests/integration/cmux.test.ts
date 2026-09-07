import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

// These exercise the CLI-free surface of the cmux command only: `up --print`
// (build + emit the layout) and `status` (no workspace recorded). A bare
// `cmux up` would talk to a live cmux app, so it is never invoked here.
describe("cmux command", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", commands: { api: { run: "true" } } },
                { key: "rn", dirname: "fake-rn" }, // no run target -> shell pane
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("cmux up --print emits a layout with a service pane and a worktree shell", () => {
        assert.equal(runMultree(sb, ["create", "g", "--include", "api,rn", "--no-cmux"]).status, 0);

        const r = runMultree(sb, ["cmux", "up", "g", "--print"]);
        assert.equal(r.status, 0, r.stderr);

        const layout = JSON.parse(r.stdout);
        assert.equal(layout.direction, "horizontal");
        assert.equal(layout.children[0].pane.surfaces[0].command, "claude");
        assert.ok(r.stdout.includes("multree run g api"), "service pane for api");
        assert.ok(r.stdout.includes(sb.worktreePath("g", "rn")), "shell pane cwd for rn");
    });

    it("cmux status reports no workspace and lists the planned panes", () => {
        assert.equal(runMultree(sb, ["create", "g", "--include", "api,rn", "--no-cmux"]).status, 0);

        const r = runMultree(sb, ["cmux", "status", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /none/);
        assert.match(r.stdout, /panes: claude, api \(api\), rn \(shell\)/);
    });

    it("errors clearly when the named group does not exist", () => {
        const r = runMultree(sb, ["cmux", "status", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });

    it("rejects an unknown cmux subcommand with usage", () => {
        const r = runMultree(sb, ["cmux", "wat", "g"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /usage: multree cmux/);
    });
});
