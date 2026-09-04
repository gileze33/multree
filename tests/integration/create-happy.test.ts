import { strict as assert } from "node:assert";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    writeFileSync,
} from "node:fs";
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

    it("links a `symlink` artifact back at the source repo's copy", () => {
        sb.cleanup();
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    primeArtifacts: [{ path: "config.local", strategy: "symlink" }],
                },
            ],
        });
        const repo = sb.repoPath("api");
        writeFileSync(join(repo, "config.local"), "shared\n");

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const linked = join(sb.worktreePath("g", "api"), "config.local");
        assert.equal(lstatSync(linked).isSymbolicLink(), true);
        assert.equal(readlinkSync(linked), join(repo, "config.local"));
        assert.equal(readFileSync(linked, "utf-8"), "shared\n");

        // The point of a link over a copy: the worktree writes through to the
        // main checkout rather than drifting from it.
        writeFileSync(linked, "edited\n");
        assert.equal(readFileSync(join(repo, "config.local"), "utf-8"), "edited\n");
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

// The manifest-level `prime_artifacts` tier: every repo inherits these on top
// of its own list, so a repo that declares nothing still gets primed. Priming
// is a join-time phase, so a shared entry added later reaches only worktrees
// created from that point on.
describe("create with manifest-level prime_artifacts", () => {
    let sb: Sandbox;

    afterEach(() => sb.cleanup());

    // AE2.
    it("primes a repo that declares no prime_artifacts of its own", () => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" /* no primeArtifacts */ }],
            primeArtifacts: [
                { path: "shared-one", strategy: "copy" },
                { find: "shared-two", strategy: "copy" },
            ],
        });
        const repo = sb.repoPath("api");
        mkdirSync(join(repo, "shared-one"), { recursive: true });
        writeFileSync(join(repo, "shared-one", "marker"), "one");
        mkdirSync(join(repo, "packages", "a", "shared-two"), { recursive: true });
        writeFileSync(join(repo, "packages", "a", "shared-two", "marker"), "two");

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const wt = sb.worktreePath("g", "api");
        assert.equal(readFileSync(join(wt, "shared-one", "marker"), "utf-8"), "one");
        assert.equal(
            readFileSync(join(wt, "packages", "a", "shared-two", "marker"), "utf-8"),
            "two",
        );
    });

    it("applies a repo's own entry to a target the manifest also declares", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    // Same target as the shared entry, so only this one runs.
                    primeArtifacts: [{ path: "shared-one", strategy: "copy" }],
                },
                { key: "frontend", dirname: "fake-frontend" },
            ],
            primeArtifacts: [{ path: "shared-one", strategy: "copy" }],
        });
        for (const key of ["api", "frontend"]) {
            const repo = sb.repoPath(key);
            mkdirSync(join(repo, "shared-one"), { recursive: true });
            writeFileSync(join(repo, "shared-one", "marker"), key);
        }

        const r = runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        assert.equal(r.status, 0, r.stderr);

        assert.equal(
            readFileSync(join(sb.worktreePath("g", "api"), "shared-one", "marker"), "utf-8"),
            "api",
        );
        assert.equal(
            readFileSync(join(sb.worktreePath("g", "frontend"), "shared-one", "marker"), "utf-8"),
            "frontend",
        );
    });

    // AE7: priming is a join-time phase, so a shared entry added after a group
    // exists reaches the next member to join and leaves the existing ones alone.
    it("applies a later-added shared entry only to worktrees created after it", () => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
        for (const key of ["api", "frontend"]) {
            const repo = sb.repoPath(key);
            mkdirSync(join(repo, "late-shared"), { recursive: true });
            writeFileSync(join(repo, "late-shared", "marker"), key);
        }

        assert.equal(runMultree(sb, ["create", "g", "--include", "api"]).status, 0);
        const apiWt = sb.worktreePath("g", "api");
        assert.equal(existsSync(join(apiWt, "late-shared")), false);

        sb.updateManifest(cfg => {
            cfg.prime_artifacts = [{ path: "late-shared", strategy: "copy" }];
        });

        const r = runMultree(sb, ["add", "g", "frontend"]);
        assert.equal(r.status, 0, r.stderr);

        assert.equal(
            readFileSync(
                join(sb.worktreePath("g", "frontend"), "late-shared", "marker"),
                "utf-8",
            ),
            "frontend",
        );
        // The existing member is untouched: priming does not re-run on it.
        assert.equal(existsSync(join(apiWt, "late-shared")), false);
    });
});


// R15: a priming-validation failure has to break the commands that would act on
// it (create, add) without locking the user out of the ones that inspect and
// tear down a group they already have on disk.
describe("prime_artifacts validation", () => {
    let sb: Sandbox;

    afterEach(() => sb.cleanup());

    it("blocks create but still allows show and destroy", () => {
        sb = createSandbox({ repos: [{ key: "api", dirname: "fake-api" }] });
        assert.equal(runMultree(sb, ["create", "g", "--include", "api"]).status, 0);

        sb.updateManifest(cfg => {
            cfg.prime_artifacts = [
                { path: "cache", strategy: "hardlink" as never },
            ];
        });

        const created = runMultree(sb, ["create", "g2", "--include", "api"]);
        assert.notEqual(created.status, 0);
        assert.match(created.stderr, /unknown strategy "hardlink"/);

        const shown = runMultree(sb, ["show", "g"]);
        assert.equal(shown.status, 0, shown.stderr);
        assert.match(shown.stdout, /Group: g/);
        assert.match(shown.stderr, /unknown strategy "hardlink"/);

        const destroyed = runMultree(sb, ["destroy", "g"]);
        assert.equal(destroyed.status, 0, destroyed.stderr);
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
    });
});

// R11/R12/R13: priming has to say what it did and what it skipped, attributed
// to the repo it did it for, in the default output — a user should be able to
// tell where each link points without opening the worktree.
describe("create prime output", () => {
    let sb: Sandbox;

    afterEach(() => sb.cleanup());

    // AE6 + a repo prefix on every priming line.
    it("prints each created link's path and target under its repo's prefix", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    primeArtifacts: [
                        { path: "config.local", strategy: "symlink" },
                        { path: "cache", strategy: "copy" },
                    ],
                },
            ],
        });
        const repo = sb.repoPath("api");
        writeFileSync(join(repo, "config.local"), "shared\n");
        mkdirSync(join(repo, "cache"), { recursive: true });

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        assert.match(
            r.stdout,
            new RegExp(`\\[api\\]\\s+config\\.local \\.\\.\\. linked -> ${join(repo, "config.local")}`),
        );
        // Every priming line carries the prefix, not just the phase banner.
        const primeLines = r.stdout
            .split("\n")
            .filter(line => /priming|linked|skipped|prime complete/.test(line));
        assert.ok(primeLines.length > 0, "no priming lines in output");
        for (const line of primeLines) {
            assert.match(line, /^\[api\]/, `unprefixed priming line: ${line}`);
        }
    });

    // AE8.
    it("reports an entry skipped for a missing source, and still exits zero", () => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" }],
            primeArtifacts: [{ path: "never-here", strategy: "symlink" }],
        });

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[api\]\s+skipped never-here \(not in /);
    });

    it("reports an occupied destination with its own distinct reason", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    // Committed, so the worktree already holds it.
                    files: { "config.local": "tracked\n" },
                    primeArtifacts: [{ path: "config.local", strategy: "symlink" }],
                },
            ],
        });

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[api\]\s+skipped config\.local \(destination already exists\)/);
        assert.doesNotMatch(r.stdout, /skipped config\.local \(not in /);
    });

    it("reports a find entry that matched nothing, naming the search value", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    primeArtifacts: [{ find: "build-cache", strategy: "copy" }],
                },
            ],
        });

        const r = runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[api\]\s+skipped find "build-cache" \(no match in /);
    });

    // AE10.
    it("lists a repo's inherited entries with targets and strategies in the dry run", () => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    primeArtifacts: [{ path: "own-cache", strategy: "copy" }],
                },
            ],
            primeArtifacts: [
                { path: "config.local", strategy: "symlink" },
                { find: "node_modules", strategy: "reflink" },
            ],
        });

        const r = runMultree(sb, ["create", "g", "--include", "api,frontend", "--plan"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[api\] path config\.local \(symlink\)/);
        assert.match(r.stdout, /\[api\] find node_modules \(reflink\)/);
        assert.match(r.stdout, /\[frontend\] path own-cache \(copy\)/);
        assert.doesNotMatch(r.stdout, /artifact spec\(s\)/);
    });

    it("reports none in the dry run for a repo with no entries at all", () => {
        sb = createSandbox({ repos: [{ key: "api", dirname: "fake-api" }] });

        const r = runMultree(sb, ["create", "g", "--include", "api", "--plan"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Phase prime[^\n]*\n\s+\[api\] \(none\)/);
    });
});
