import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("create + destroy (happy path)", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup", `echo "API_PORT=5234" > .env.local`),
                    teardown: trace("api:teardown"),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "API_PORT" },
                    },
                    defaults: { port: 5000 },
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    setup: trace("frontend:setup"),
                    teardown: trace("frontend:teardown"),
                    files: { ".env": "EXISTING=keep\n" },
                    consumes: {
                        file: ".env",
                        upsert: { API_URL: "http://localhost:{api.port}" },
                    },
                },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("creates worktrees, runs setup, wires env, persists state", () => {
        const result = runMultree(sb, ["create", "demo", "--include", "api,frontend"]);
        assert.equal(result.status, 0, `non-zero exit\n${result.stderr}`);

        const state = sb.state("demo");
        assert.ok(state, "state file not written");
        assert.deepEqual(Object.keys(state!.members), ["api", "frontend"]);
        assert.equal(state!.members.api.exposes.port, "5234");

        assert.ok(existsSync(sb.worktreePath("demo", "api")), "api worktree missing");
        assert.ok(existsSync(sb.worktreePath("demo", "frontend")), "frontend worktree missing");

        const frontendEnv = readFileSync(join(sb.worktreePath("demo", "frontend"), ".env"), "utf-8");
        assert.match(frontendEnv, /EXISTING=keep/);
        assert.match(frontendEnv, /API_URL=http:\/\/localhost:5234/);
        assert.match(frontendEnv, /# >>> multree-managed: demo >>>/);

        assert.deepEqual(sb.trace(), ["api:setup", "frontend:setup"]);
    });

    it("destroy removes worktrees, runs teardown, deletes state", () => {
        runMultree(sb, ["create", "demo", "--include", "api,frontend"]);
        const r = runMultree(sb, ["destroy", "demo"]);
        assert.equal(r.status, 0, `destroy exit non-zero\n${r.stderr}`);

        assert.equal(existsSync(join(sb.worktreeRoot, "demo")), false);
        assert.equal(sb.state("demo"), null);
        const events = sb.trace();
        assert.ok(events.includes("api:teardown"));
        assert.ok(events.includes("frontend:teardown"));
    });

    it("frontends without api in the group fall back to defaults", () => {
        const r = runMultree(sb, ["create", "solo", "--include", "frontend"]);
        assert.equal(r.status, 0, r.stderr);

        const frontendEnv = readFileSync(join(sb.worktreePath("solo", "frontend"), ".env"), "utf-8");
        assert.match(frontendEnv, /API_URL=http:\/\/localhost:5000/);
    });
});

// `default_include` is the manifest-level repo selection `create` falls back to
// when `--include` is omitted. Covers each variant the knob has: the flag
// winning, the fallback firing, neither present, and the invalid-manifest cases
// that must fail at config load rather than mid-create.
describe("create with default_include", () => {
    let sb: Sandbox;

    const build = (defaultInclude?: string[]): Sandbox =>
        createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", setup: trace("api:setup") },
                { key: "frontend", dirname: "fake-frontend", setup: trace("frontend:setup") },
            ],
            defaultInclude,
        });

    beforeEach(() => {
        sb = build(["api", "frontend"]);
    });

    afterEach(() => sb.cleanup());

    it("falls back to default_include when --include is omitted", () => {
        const r = runMultree(sb, ["create", "demo"]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);
        assert.match(r.stdout, /Using default_include: api, frontend/);

        const state = sb.state("demo");
        assert.deepEqual(Object.keys(state!.members), ["api", "frontend"]);
    });

    it("prefers an explicit --include over default_include", () => {
        const r = runMultree(sb, ["create", "demo", "--include", "api"]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);
        assert.doesNotMatch(r.stdout, /Using default_include/);

        const state = sb.state("demo");
        assert.deepEqual(Object.keys(state!.members), ["api"]);
    });

    it("errors naming both routes when neither --include nor default_include is set", () => {
        sb.cleanup();
        sb = build(undefined);

        const r = runMultree(sb, ["create", "demo"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /create requires --include <repo,\.\.\.>/);
        assert.match(r.stderr, /set default_include in .*default\.yaml/);
        assert.equal(existsSync(join(sb.worktreeRoot, "demo")), false);
    });

    // A bare `--include` is a typo, not a request for the manifest default.
    it("rejects a valueless --include instead of falling back", () => {
        const r = runMultree(sb, ["create", "demo", "--include"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /--include requires a repo list/);
        assert.equal(existsSync(join(sb.worktreeRoot, "demo")), false);
    });

    // Validation lives in config.ts, so a bad default_include has to break every
    // command — not just surface halfway through a create.
    it("rejects an unknown repo in default_include at config load", () => {
        sb.cleanup();
        sb = build(["api", "phantom"]);

        const r = runMultree(sb, ["list"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /default_include lists unknown repo "phantom"/);
    });
});

// End-to-end coverage that the prime phase actually copies the source repo's
// working-tree artifacts into a new worktree during `multree create`. The
// unit tests in tests/unit/artifacts.test.ts exercise primeArtifacts directly;
// this test pins the wiring through the CLI.
describe("create with prime_artifacts", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    primeArtifacts: [
                        { path: "node_modules", strategy: "copy" },
                        { find: "build-cache", strategy: "copy" },
                    ],
                },
            ],
        });
        // Plant working-tree-only artifacts in the source repo (post-commit,
        // so they're not on `develop` and the new worktree starts without
        // them). This mirrors a real dev's `npm install` outputs.
        const repo = sb.repoPath("api");
        mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;");
        mkdirSync(join(repo, "packages", "a", "build-cache"), { recursive: true });
        writeFileSync(join(repo, "packages", "a", "build-cache", "marker"), "cache-a");
    });
    afterEach(() => sb.cleanup());

    it("copies `path` and `find` artifacts from the source repo into the worktree", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const wt = sb.worktreePath("g", "api");
        const copiedNm = join(wt, "node_modules", "pkg", "index.js");
        assert.equal(readFileSync(copiedNm, "utf-8"), "module.exports = 1;");

        const copiedCache = join(wt, "packages", "a", "build-cache", "marker");
        assert.equal(readFileSync(copiedCache, "utf-8"), "cache-a");
    });

    // primeArtifacts defaults to strategy: "copy" when the field is unset.
    // Unit tests cover this on the helper directly; this pins the manifest
    // round-trip so an accidental upstream rename of the default would break.
    it("defaults to the copy strategy when none is set on a spec", () => {
        sb.cleanup();
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    primeArtifacts: [{ path: "out-dir" /* no strategy */ }],
                },
            ],
        });
        const repo = sb.repoPath("api");
        mkdirSync(join(repo, "out-dir"), { recursive: true });
        writeFileSync(join(repo, "out-dir", "marker"), "default-strategy");

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const primed = join(sb.worktreePath("g", "api"), "out-dir", "marker");
        assert.equal(readFileSync(primed, "utf-8"), "default-strategy");
    });
});
