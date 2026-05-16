import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MultreeConfig } from "../../src/types.ts";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

function patchManifest(sb: Sandbox, mutate: (cfg: MultreeConfig) => void): void {
    const cfg = parse(readFileSync(sb.manifestPath, "utf-8")) as MultreeConfig;
    mutate(cfg);
    writeFileSync(sb.manifestPath, stringify(cfg));
}

describe("tool dispatch", () => {
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

    it("runs a shell-string tool with {cwd} substitution at the group root", () => {
        const marker = join(sb.root, "marker.txt");
        patchManifest(sb, cfg => {
            cfg.tools = {
                touch: { command: `echo "{cwd}" > "${marker}"`, open_in: "$root" },
            };
        });

        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["touch", "g"]);
        assert.equal(r.status, 0, r.stderr);

        const written = readFileSync(marker, "utf-8").trim();
        assert.equal(written, join(sb.worktreeRoot, "g"));
    });

    it("runs an argv-array tool, substituting {cwd} per argument", () => {
        const marker = join(sb.root, "argv-marker.txt");
        patchManifest(sb, cfg => {
            cfg.tools = {
                stamp: {
                    command: ["/bin/sh", "-c", `echo "$1" > "${marker}"`, "_", "{cwd}"],
                    open_in: "$root",
                },
            };
        });

        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["stamp", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(marker, "utf-8").trim(), join(sb.worktreeRoot, "g"));
    });

    it("opens at the first matching member in an open_in chain", () => {
        const marker = join(sb.root, "chain-marker.txt");
        patchManifest(sb, cfg => {
            cfg.tools = {
                here: { command: `echo "{cwd}" > "${marker}"`, open_in: ["frontend", "$root"] },
            };
        });

        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const r = runMultree(sb, ["here", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(marker, "utf-8").trim(), sb.worktreePath("g", "frontend"));
    });

    it("defaults to $root when open_in is omitted entirely", () => {
        const marker = join(sb.root, "default-cwd-marker.txt");
        patchManifest(sb, cfg => {
            cfg.tools = {
                // No open_in: resolveCwd treats this the same as ["$root"].
                stamp: { command: `echo "{cwd}" > "${marker}"` },
            };
        });

        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["stamp", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(marker, "utf-8").trim(), join(sb.worktreeRoot, "g"));
    });

    it("falls back to $root when no member in the chain is present", () => {
        const marker = join(sb.root, "fallback-marker.txt");
        patchManifest(sb, cfg => {
            cfg.tools = {
                here: { command: `echo "{cwd}" > "${marker}"`, open_in: ["frontend", "$root"] },
            };
        });

        // Only api in the group — frontend not present.
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["here", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(marker, "utf-8").trim(), join(sb.worktreeRoot, "g"));
    });

    it("propagates a tool's non-zero exit code", () => {
        patchManifest(sb, cfg => {
            cfg.tools = {
                fail: { command: "exit 42", open_in: "$root" },
            };
        });

        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["fail", "g"]);
        assert.equal(r.status, 42);
    });

    it("errors clearly when the named group does not exist", () => {
        patchManifest(sb, cfg => {
            cfg.tools = { ok: { command: "true", open_in: "$root" } };
        });

        const r = runMultree(sb, ["ok", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });

    it("appears in `multree help` once defined in the manifest", () => {
        patchManifest(sb, cfg => {
            cfg.tools = { custom: { command: "true", open_in: "$root" } };
        });

        const r = runMultree(sb, ["help"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /custom/);
    });
});

// Sanity check: a `_` shim file is required for argv-style tool dispatch to behave like a real CLI invocation.
// This block also guards against accidentally shipping a manifest test that depends on the host shell.
describe("tool dispatch: builtins win over manifest tools", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api", setup: trace("api:setup") }],
        });
    });
    afterEach(() => sb.cleanup());

    it("a tool named the same as a builtin is shadowed by the builtin", () => {
        patchManifest(sb, cfg => {
            cfg.tools = {
                list: { command: "exit 99", open_in: "$root" },
            };
        });
        runMultree(sb, ["create", "g", "--include", "api"]);

        const r = runMultree(sb, ["list"]);
        assert.equal(r.status, 0, r.stderr);
        // Builtin `list` prints group names; the shadowed tool would have exited 99.
        assert.match(r.stdout, /g/);
    });
});
