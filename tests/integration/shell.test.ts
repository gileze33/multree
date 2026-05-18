import { strict as assert } from "node:assert";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// Stand-in for the user's interactive shell. The CLI spawns whatever `$SHELL`
// points at with no args and stdio inherited; this script writes its cwd to a
// marker file then exits 0, so we can assert on the working directory without
// actually opening a tty.
function fakeShell(sb: Sandbox, marker: string): string {
    const path = join(sb.root, "fake-shell.sh");
    writeFileSync(path, `#!/bin/sh\npwd > "${marker}"\n`, { mode: 0o755 });
    return path;
}

describe("shell", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", setup: trace("api:setup") },
                { key: "frontend", dirname: "fake-frontend", setup: trace("frontend:setup") },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("opens a shell at the group root by default", () => {
        const marker = join(sb.root, "cwd.txt");
        sb.env.SHELL = fakeShell(sb, marker);

        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const r = runMultree(sb, ["shell", "g"]);

        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(marker), "shell did not run");
        assert.equal(readFileSync(marker, "utf-8").trim(), realpathSync(join(sb.worktreeRoot, "g")));
    });

    it("opens a shell inside a specific member's worktree when a repo is given", () => {
        const marker = join(sb.root, "cwd.txt");
        sb.env.SHELL = fakeShell(sb, marker);

        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const r = runMultree(sb, ["shell", "g", "frontend"]);

        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(marker, "utf-8").trim(), realpathSync(sb.worktreePath("g", "frontend")));
    });

    it("errors when the named repo is not a member of the group", () => {
        sb.env.SHELL = fakeShell(sb, join(sb.root, "unused.txt"));

        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["shell", "g", "frontend"]);

        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /frontend.*group "g"/);
    });

    it("errors when the group does not exist", () => {
        sb.env.SHELL = fakeShell(sb, join(sb.root, "unused.txt"));

        const r = runMultree(sb, ["shell", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });
});
