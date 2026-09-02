import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

// macOS reports `pwd` through the real path (/private/var/...), while the
// worktree paths multree computes keep the /var symlink. Normalise both ends.
function realCwd(...parts: string[]): string {
    return realpathSync(join(...parts));
}

describe("repo command dispatch", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "client",
                    dirname: "monorepo-client",
                    files: { "packages/north/.keep": "", "packages/south/.keep": "" },
                    commands: {
                        north: {
                            cwd: "packages/north",
                            run: "echo CWD=$(pwd)",
                            build: "echo BUILT-north",
                        },
                        // action-level cwd points elsewhere, beating the target cwd.
                        override: {
                            cwd: "packages/north",
                            run: { command: "echo CWD=$(pwd)", cwd: "packages/south" },
                        },
                        // no cwd: runs at the worktree root.
                        rootcmd: { run: "echo CWD=$(pwd)" },
                        boom: { run: "exit 42" },
                    },
                },
            ],
        });
        runMultree(sb, ["create", "g", "--include", "client"]);
    });

    afterEach(() => sb.cleanup());

    it("runs an action in its target's cwd subdir", () => {
        const r = runMultree(sb, ["run", "g", "north"]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(
            r.stdout.includes(`CWD=${realCwd(sb.worktreePath("g", "client"), "packages/north")}\n`),
            r.stdout,
        );
    });

    it("lets an action-level cwd override the target cwd", () => {
        const r = runMultree(sb, ["run", "g", "override"]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(
            r.stdout.includes(`CWD=${realCwd(sb.worktreePath("g", "client"), "packages/south")}\n`),
            r.stdout,
        );
    });

    it("runs at the worktree root when the target has no cwd", () => {
        const r = runMultree(sb, ["run", "g", "rootcmd"]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes(`CWD=${realCwd(sb.worktreePath("g", "client"))}\n`), r.stdout);
    });

    it("dispatches a non-run action verb (proves verbs are open-ended)", () => {
        const r = runMultree(sb, ["build", "g", "north"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /BUILT-north/);
    });

    it("lists the available targets when no target is given", () => {
        const r = runMultree(sb, ["run", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /run targets in "g": boom, north, override, rootcmd/);
    });

    it("errors clearly on an unknown target", () => {
        const r = runMultree(sb, ["run", "g", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /No target "ghost"/);
    });

    it("errors when the target does not declare that action", () => {
        const r = runMultree(sb, ["build", "g", "rootcmd"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /has no action "build"/);
    });

    it("propagates a non-zero exit code", () => {
        const r = runMultree(sb, ["run", "g", "boom"]);
        assert.equal(r.status, 42);
    });

    it("resolves the shell through PATH rather than a hardcoded /bin/bash", () => {
        // A `bash` earlier on PATH than the real one, logging how it was called.
        // An absolute interpreter path in the runner bypasses it entirely.
        //
        // Matching on the `-c` form is load-bearing: `bin/multree` is itself
        // `#!/usr/bin/env bash`, so the shim is hit for the launcher whatever the
        // runner does. Only `runForeground` invokes it as `bash -c <command>`.
        const shimDir = join(sb.root, "shim-bin");
        mkdirSync(shimDir, { recursive: true });
        const log = join(sb.root, "shim-calls.log");
        const shim = join(shimDir, "bash");
        writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec /bin/bash "$@"\n`);
        chmodSync(shim, 0o755);

        const env = { ...sb.env, PATH: `${shimDir}:${sb.env.PATH ?? ""}` };
        const r = runMultree({ env }, ["run", "g", "north"]);
        assert.equal(r.status, 0, r.stderr);

        const calls = readFileSync(log, "utf-8");
        assert.match(calls, /^-c .*echo CWD=/m, `shim was never asked to run the command:\n${calls}`);
    });

    it("lists repo command verbs in help", () => {
        const r = runMultree(sb, ["help"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /multree <build\|run> <name> <target>/);
    });
});

describe("repo command dispatch: target name collisions", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "client", dirname: "client-a", commands: { north: { run: "echo a" } } },
                { key: "other", dirname: "client-b", commands: { north: { run: "echo b" } } },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("resolves fine when only one member defines the target", () => {
        runMultree(sb, ["create", "solo", "--include", "client"]);
        const r = runMultree(sb, ["run", "solo", "north"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^a$/m); // `echo a` ran
    });

    it("errors when two members define the same target name", () => {
        runMultree(sb, ["create", "dup", "--include", "client,other"]);
        const r = runMultree(sb, ["run", "dup", "north"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /defined by more than one repo.*rename one/s);
    });
});
