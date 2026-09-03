import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    expandPath,
    loadConfig,
    resolveBranchBase,
    resolvePrimeArtifacts,
} from "../../src/config.ts";
import type { MultreeConfig, PrimeArtifactSpec, RepoConfig } from "../../src/types.ts";

describe("expandPath", () => {
    // Env var test hygiene: we manipulate process.env in this block, snapshot
    // any names we touch in beforeEach and restore in afterEach so nothing
    // leaks between tests or out into other suites.
    const TOUCHED_VARS = [
        "MULTREE_TEST_BASE",
        "MULTREE_TEST_OTHER",
        "MULTREE_TEST_EMPTY",
        "MULTREE_TEST_TILDE_VALUE",
        "MULTREE_TEST_INNER",
        "MULTREE_TEST_OUTER",
    ];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const k of TOUCHED_VARS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of TOUCHED_VARS) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    });

    it("expands a leading ~/ to the home directory", () => {
        const out = expandPath("~/foo/bar");
        assert.ok(out.endsWith("/foo/bar"));
        assert.ok(!out.startsWith("~"));
    });

    it("does not expand ~ that isn't at the start", () => {
        assert.equal(expandPath("/etc/~/foo"), "/etc/~/foo");
    });

    it("returns absolute paths unchanged", () => {
        assert.equal(expandPath("/var/log"), "/var/log");
    });

    it("returns relative paths unchanged", () => {
        assert.equal(expandPath("relative/path"), "relative/path");
    });

    it("substitutes a single ${VAR} reference", () => {
        process.env.MULTREE_TEST_BASE = "/srv/code";
        assert.equal(expandPath("${MULTREE_TEST_BASE}/api"), "/srv/code/api");
    });

    it("substitutes multiple ${VAR} references in the same string", () => {
        process.env.MULTREE_TEST_BASE = "/srv";
        process.env.MULTREE_TEST_OTHER = "code";
        assert.equal(
            expandPath("${MULTREE_TEST_BASE}/${MULTREE_TEST_OTHER}/api"),
            "/srv/code/api",
        );
    });

    it("expands env vars before applying the leading ~/", () => {
        // `~/${VAR}/api` should produce <home>/<value>/api: tilde at the head
        // of the literal still wins, env value drops in mid-path.
        process.env.MULTREE_TEST_BASE = "projects";
        const out = expandPath("~/${MULTREE_TEST_BASE}/api");
        assert.ok(out.endsWith("/projects/api"));
        assert.ok(!out.startsWith("~"));
    });

    it("re-applies ~/ expansion when an env value starts with ~/", () => {
        // User-set env can be "~/foo" — shells don't expand tilde in env, so a
        // user typing `export MULTREE_X=~/foo` ends up with a literal "~/" in
        // the value. Treating it the same as a yaml-literal tilde matches user
        // expectation.
        process.env.MULTREE_TEST_TILDE_VALUE = "~/projects";
        const out = expandPath("${MULTREE_TEST_TILDE_VALUE}/api");
        assert.ok(out.endsWith("/projects/api"));
        assert.ok(!out.startsWith("~"));
    });

    it("does NOT recursively re-expand env vars referenced inside an env value", () => {
        // If MULTREE_TEST_OUTER expanded to a string containing ${INNER}, we
        // would have to define a precedence between yaml-author intent and
        // env-author intent, plus guard against cycles. Easier and safer to
        // expand exactly once.
        process.env.MULTREE_TEST_OUTER = "${MULTREE_TEST_INNER}/api";
        process.env.MULTREE_TEST_INNER = "/should-not-appear";
        assert.equal(
            expandPath("${MULTREE_TEST_OUTER}"),
            "${MULTREE_TEST_INNER}/api",
        );
    });

    it("leaves a literal `$VAR` (no braces) untouched", () => {
        // Only `${...}` is recognised. A bare `$cache` is just a path segment.
        assert.equal(expandPath("/var/$cache/foo"), "/var/$cache/foo");
    });

    // --- dangerous cases: these must FAIL LOUDLY ---

    it("throws when a referenced env var is undefined (silent empty substitution would be dangerous)", () => {
        // The canonical bad path: `${BASE}/api` quietly becoming `/api` and
        // pointing a worktree (or worse, a destroy) at the wrong tree.
        assert.throws(
            () => expandPath("${MULTREE_TEST_BASE}/api"),
            /MULTREE_TEST_BASE.*unset or empty/,
        );
    });

    it("throws when a referenced env var is set but empty (same risk as undefined)", () => {
        process.env.MULTREE_TEST_EMPTY = "";
        assert.throws(
            () => expandPath("${MULTREE_TEST_EMPTY}/api"),
            /MULTREE_TEST_EMPTY.*unset or empty/,
        );
    });

    it("includes the offending placeholder in the error message", () => {
        // Helps the user find where in their yaml the bad reference came from
        // when commands eventually surface this through err.message.
        assert.throws(
            () => expandPath("${MULTREE_TEST_BASE}/api"),
            /manifest path "\$\{MULTREE_TEST_BASE\}\/api"/,
        );
    });

    it("throws on an empty placeholder `${}`", () => {
        assert.throws(() => expandPath("${}/api"), /Invalid env var name ""/);
    });

    it("throws on a placeholder with whitespace `${a b}`", () => {
        assert.throws(() => expandPath("${a b}/api"), /Invalid env var name "a b"/);
    });

    it("throws on a placeholder whose name starts with a digit", () => {
        // POSIX env var names must start with a letter or underscore.
        assert.throws(() => expandPath("${1BAD}/api"), /Invalid env var name "1BAD"/);
    });

    it("throws on a placeholder with shell-metachar contents", () => {
        // Defence in depth: even though the result flows through execFileSync
        // argv (not a shell), we don't want to accept names that look like
        // command substitution. The "must match" regex rejects them at parse
        // time, so a malicious yaml saying `${$(rm -rf /)}` gets caught here
        // rather than relying on downstream callers to sanitise.
        assert.throws(
            () => expandPath("${$(whoami)}/api"),
            /Invalid env var name/,
        );
    });
});

describe("resolveBranchBase", () => {
    it("uses the per-repo branch_base when set", () => {
        assert.equal(resolveBranchBase({ branch_base: "origin/develop" }), "origin/develop");
    });

    it("falls back to origin/main when no override is set", () => {
        assert.equal(resolveBranchBase({}), "origin/main");
    });
});

// A repo's effective priming list is the manifest-level entries plus its own,
// with the repo's entry winning for any target both tiers declare.
describe("resolvePrimeArtifacts", () => {
    const build = (
        manifest: PrimeArtifactSpec[] | undefined,
        repo: PrimeArtifactSpec[] | undefined,
    ): { cfg: MultreeConfig; repoCfg: RepoConfig } => {
        const repoCfg: RepoConfig = { path: "/tmp/api", prime_artifacts: repo };
        return {
            cfg: { version: 1, repos: { api: repoCfg }, prime_artifacts: manifest },
            repoCfg,
        };
    };

    it("gives a repo that declares nothing every manifest-level entry", () => {
        const { cfg, repoCfg } = build(
            [
                { path: "config.local", strategy: "copy" },
                { find: "node_modules", strategy: "reflink" },
            ],
            undefined,
        );
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { path: "config.local", strategy: "copy" },
            { find: "node_modules", strategy: "reflink" },
        ]);
    });

    it("gives a repo with its own entries those plus the manifest-level ones", () => {
        const { cfg, repoCfg } = build(
            [{ find: "node_modules", strategy: "reflink" }],
            [{ path: "cache", strategy: "copy" }],
        );
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { path: "cache", strategy: "copy" },
            { find: "node_modules", strategy: "reflink" },
        ]);
    });

    // AE1: the repo's entry is the one applied to a shared target, and the
    // manifest's entry for it is dropped rather than applied second.
    it("lets a repo entry replace a manifest entry for the same path", () => {
        const { cfg, repoCfg } = build(
            [{ path: "config.local", strategy: "reflink" }],
            [{ path: "config.local", strategy: "copy" }],
        );
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { path: "config.local", strategy: "copy" },
        ]);
    });

    it("lets a repo entry replace a manifest entry for the same find value", () => {
        const { cfg, repoCfg } = build(
            [{ find: "node_modules", strategy: "reflink" }],
            [{ find: "node_modules", strategy: "copy" }],
        );
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { find: "node_modules", strategy: "copy" },
        ]);
    });

    // `path: x` and `find: x` are different targets: one is a literal location,
    // the other a basename searched for anywhere in the tree.
    it("treats a path and a find naming the same string as separate targets", () => {
        const { cfg, repoCfg } = build(
            [{ find: "cache", strategy: "reflink" }],
            [{ path: "cache", strategy: "copy" }],
        );
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { path: "cache", strategy: "copy" },
            { find: "cache", strategy: "reflink" },
        ]);
    });

    it("orders a repo's own entries ahead of the inherited ones", () => {
        const { cfg, repoCfg } = build(
            [{ path: "shared-a" }, { path: "shared-b" }],
            [{ path: "own-a" }, { path: "own-b" }],
        );
        assert.deepEqual(
            resolvePrimeArtifacts(cfg, repoCfg).map(spec => spec.path),
            ["own-a", "own-b", "shared-a", "shared-b"],
        );
    });

    it("leaves per-repo behaviour unchanged when the manifest declares none", () => {
        const { cfg, repoCfg } = build(undefined, [{ find: "node_modules", strategy: "reflink" }]);
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), [
            { find: "node_modules", strategy: "reflink" },
        ]);
    });

    it("returns an empty list when neither tier declares anything", () => {
        const { cfg, repoCfg } = build(undefined, undefined);
        assert.deepEqual(resolvePrimeArtifacts(cfg, repoCfg), []);
    });
});

describe("loadConfig", () => {
    let home: string;
    const savedHome = process.env.MULTREE_HOME;
    const savedProfile = process.env.MULTREE_PROFILE;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-config-"));
        mkdirSync(home, { recursive: true });
        process.env.MULTREE_HOME = home;
        delete process.env.MULTREE_PROFILE;
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        if (savedHome === undefined) {
            delete process.env.MULTREE_HOME;
        } else {
            process.env.MULTREE_HOME = savedHome;
        }
        if (savedProfile === undefined) {
            delete process.env.MULTREE_PROFILE;
        } else {
            process.env.MULTREE_PROFILE = savedProfile;
        }
    });

    it("throws a helpful error when the default profile yaml is missing", () => {
        assert.throws(
            () => loadConfig(),
            /No multree manifest at .*default\.yaml/,
        );
    });

    it("throws on an unsupported config version", () => {
        writeFileSync(join(home, "default.yaml"), "version: 2\nrepos:\n  api:\n    path: /tmp\n");
        assert.throws(() => loadConfig(), /Unsupported config version/);
    });

    it("throws when no repos are defined", () => {
        writeFileSync(join(home, "default.yaml"), "version: 1\nrepos: {}\n");
        assert.throws(() => loadConfig(), /no repos defined/);
    });

    it("throws when a repo is missing its path", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  api:\n    branch_base: origin/main\n",
        );
        assert.throws(() => loadConfig(), /missing required field: path/);
    });

    it("loads a minimal valid manifest and returns its path", () => {
        const p = join(home, "default.yaml");
        writeFileSync(p, "version: 1\nrepos:\n  api:\n    path: /tmp/api\n");
        const { config, path } = loadConfig();
        assert.equal(path, p);
        assert.equal(config.version, 1);
        assert.equal(config.repos.api.path, "/tmp/api");
    });

    it("rejects depends_on pointing at an unknown repo", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  api:\n    path: /tmp/api\n  frontend:\n    path: /tmp/frontend\n    depends_on: [ghost]\n",
        );
        assert.throws(() => loadConfig(), /depends_on unknown repo "ghost"/);
    });

    it("rejects depends_on pointing at the repo itself", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  api:\n    path: /tmp/api\n    depends_on: [api]\n",
        );
        assert.throws(() => loadConfig(), /depends_on itself/);
    });

    it("rejects a depends_on cycle", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n" +
                "  a:\n    path: /tmp/a\n    depends_on: [b]\n" +
                "  b:\n    path: /tmp/b\n    depends_on: [a]\n",
        );
        assert.throws(() => loadConfig(), /depends_on cycle/);
    });

    it("rejects a variable with an unsupported type", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        type: uuid\n        min: 1\n        max: 2\n",
        );
        assert.throws(() => loadConfig(), /unsupported type "uuid"/);
    });

    it("rejects a variable whose min exceeds its max", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        min: 5000\n        max: 4000\n",
        );
        assert.throws(() => loadConfig(), /min \(5000\) must be <= max \(4000\)/);
    });

    it("rejects a variable with a non-integer bound", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        min: 4000.5\n        max: 5000\n",
        );
        assert.throws(() => loadConfig(), /min and max must be integers/);
    });

    it("rejects a variable with a non-integer default", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        min: 4000\n        max: 5000\n        default: 4000.5\n",
        );
        assert.throws(() => loadConfig(), /default must be an integer/);
    });

    it("accepts a variable default outside the allocatable range", () => {
        // A default can legitimately be a well-known shared port outside the
        // ephemeral [min, max] allocation window.
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        min: 4000\n        max: 5000\n        default: 80\n",
        );
        const { config } = loadConfig();
        assert.equal(config.repos.web.variables?.port.default, 80);
    });

    it("accepts a valid number variable (type defaults to number)", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    variables:\n      port:\n        min: 4000\n        max: 5000\n",
        );
        const { config } = loadConfig();
        assert.equal(config.repos.web.variables?.port.min, 4000);
        assert.equal(config.repos.web.variables?.port.max, 5000);
    });

    it("accepts a valid depends_on graph", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n" +
                "  api:\n    path: /tmp/api\n" +
                "  frontend:\n    path: /tmp/frontend\n    depends_on: [api]\n",
        );
        const { config } = loadConfig();
        assert.deepEqual(config.repos.frontend.depends_on, ["api"]);
    });

    it("rejects a command action that shadows a builtin subcommand", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        list: yarn dev\n",
        );
        assert.throws(() => loadConfig(), /shadows the built-in subcommand "list"/);
    });

    it("rejects a command action that collides with a tool name", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\ntools:\n  open:\n    command: code\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        open: yarn dev\n",
        );
        assert.throws(() => loadConfig(), /collides with the tool "open"/);
    });

    it("rejects an absolute command cwd", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        cwd: /abs/path\n        run: yarn dev\n",
        );
        assert.throws(() => loadConfig(), /cwd must be a relative path/);
    });

    it("rejects a command target with no actions", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        cwd: packages/app\n",
        );
        assert.throws(() => loadConfig(), /defines no actions/);
    });

    it("rejects an empty command string", () => {
        writeFileSync(
            join(home, "default.yaml"),
            'version: 1\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        run: ""\n',
        );
        assert.throws(() => loadConfig(), /command must not be empty/);
    });

    it("accepts a valid commands block", () => {
        writeFileSync(
            join(home, "default.yaml"),
            "version: 1\nrepos:\n  web:\n    path: /tmp/web\n    commands:\n      app:\n        cwd: packages/app\n        run: yarn dev\n        build: yarn build\n",
        );
        const { config } = loadConfig();
        assert.equal(config.repos.web.commands?.app.cwd, "packages/app");
        assert.equal(config.repos.web.commands?.app.run, "yarn dev");
        assert.equal(config.repos.web.commands?.app.build, "yarn build");
    });

    // default_include is validated at load — not inside `create` — so a typo
    // surfaces on any command instead of halfway through building a group.
    const TWO_REPOS = "version: 1\nrepos:\n  api:\n    path: /tmp/api\n  frontend:\n    path: /tmp/frontend\n";

    it("rejects an unknown repo in default_include", () => {
        writeFileSync(join(home, "default.yaml"), `${TWO_REPOS}default_include: [api, ghost]\n`);
        assert.throws(
            () => loadConfig(),
            /default_include lists unknown repo "ghost"\. Available: api, frontend/,
        );
    });

    it("rejects an empty default_include", () => {
        writeFileSync(join(home, "default.yaml"), `${TWO_REPOS}default_include: []\n`);
        assert.throws(() => loadConfig(), /default_include must be a non-empty list/);
    });

    it("rejects a duplicated repo in default_include", () => {
        writeFileSync(join(home, "default.yaml"), `${TWO_REPOS}default_include: [api, api]\n`);
        assert.throws(() => loadConfig(), /default_include lists "api" more than once/);
    });

    it("rejects a non-string default_include entry", () => {
        writeFileSync(join(home, "default.yaml"), `${TWO_REPOS}default_include: [api, 7]\n`);
        assert.throws(() => loadConfig(), /default_include entries must be non-empty repo keys/);
    });

    it("accepts a valid default_include", () => {
        writeFileSync(join(home, "default.yaml"), `${TWO_REPOS}default_include: [api, frontend]\n`);
        const { config } = loadConfig();
        assert.deepEqual(config.default_include, ["api", "frontend"]);
    });

    // prime_artifacts is validated at load rather than when the prime phase
    // runs: a manifest-level entry is read by every repo, so a malformed one
    // would otherwise fail every member's prime after the worktrees exist.
    const API = 'version: 1\nrepos:\n  api:\n    path: /tmp/api\n';
    const primeYaml = (repoEntries: string, manifestEntries?: string): string =>
        API +
        (repoEntries === "" ? "" : `    prime_artifacts:\n${repoEntries}`) +
        (manifestEntries === undefined ? "" : `prime_artifacts:\n${manifestEntries}`);

    it("rejects a repo entry declaring both path and find", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("      - path: cache\n        find: cache\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: specify either 'path' or 'find', not both/,
        );
    });

    it("rejects a repo entry declaring neither path nor find", () => {
        writeFileSync(join(home, "default.yaml"), primeYaml("      - strategy: copy\n"));
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: must specify 'path' or 'find'/,
        );
    });

    it("rejects an empty path value", () => {
        writeFileSync(join(home, "default.yaml"), primeYaml('      - path: ""\n'));
        assert.throws(() => loadConfig(), /path must be a non-empty string/);
    });

    it("rejects an unknown strategy, naming the offending value", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("      - path: cache\n        strategy: hardlink\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: unknown strategy "hardlink"/,
        );
    });

    // AE9.
    it("rejects a repo repeating a target within its own list", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("      - path: cache\n      - path: cache\n        strategy: reflink\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: declares path "cache" more than once/,
        );
    });

    it("accepts a repo declaring the same string as a path and as a find", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("      - path: cache\n      - find: cache\n"),
        );
        const { config } = loadConfig();
        assert.equal(config.repos.api.prime_artifacts?.length, 2);
    });

    it("rejects a manifest-level entry declaring both path and find", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("", "  - path: cache\n    find: cache\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Manifest-level prime_artifacts: specify either 'path' or 'find', not both/,
        );
    });

    it("rejects a manifest-level entry naming an unknown strategy", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("", "  - path: cache\n    strategy: hardlink\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Manifest-level prime_artifacts: unknown strategy "hardlink"/,
        );
    });

    it("rejects a target repeated within the manifest-level list", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("", "  - find: node_modules\n  - find: node_modules\n"),
        );
        assert.throws(
            () => loadConfig(),
            /Manifest-level prime_artifacts: declares find "node_modules" more than once/,
        );
    });

    // The collision guard: a symlink writes through to the main checkout, so a
    // link over a file multree itself wires would corrupt the source repo.
    const CONSUMER =
        'version: 1\nrepos:\n  api:\n    path: /tmp/api\n' +
        "    consumes:\n      file: config/app.env\n      upsert:\n        K: v\n";

    // AE5.
    it("rejects an inherited symlink entry over a consumed file, naming the tier", () => {
        writeFileSync(
            join(home, "default.yaml"),
            `${CONSUMER}prime_artifacts:\n  - path: config/app.env\n    strategy: symlink\n`,
        );
        assert.throws(() => loadConfig(), err => {
            const msg = (err as Error).message;
            assert.match(msg, /Manifest-level prime_artifacts/);
            assert.match(msg, /inherited by repo "api"/);
            assert.match(msg, /config\/app\.env/);
            return true;
        });
    });

    it("rejects a symlink entry for a directory containing a consumed file", () => {
        writeFileSync(
            join(home, "default.yaml"),
            `${CONSUMER}    prime_artifacts:\n      - path: config\n        strategy: symlink\n`,
        );
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: symlink entry "config".*consumes.*config\/app\.env/s,
        );
    });

    it("accepts a symlink entry sharing a prefix without a segment boundary", () => {
        writeFileSync(
            join(home, "default.yaml"),
            `${CONSUMER}    prime_artifacts:\n      - path: conf\n        strategy: symlink\n`,
        );
        const { config } = loadConfig();
        assert.equal(config.repos.api.prime_artifacts?.[0].path, "conf");
    });

    it("accepts a copy entry for a consumed file — the guard is symlink-only", () => {
        writeFileSync(
            join(home, "default.yaml"),
            `${CONSUMER}    prime_artifacts:\n` +
                "      - path: config/app.env\n        strategy: copy\n" +
                "      - path: config\n        strategy: reflink\n",
        );
        const { config } = loadConfig();
        assert.equal(config.repos.api.prime_artifacts?.length, 2);
    });

    it("rejects a symlink entry for a file the repo exposes", () => {
        writeFileSync(
            join(home, "default.yaml"),
            'version: 1\nrepos:\n  api:\n    path: /tmp/api\n' +
                "    exposes:\n      port:\n        type: env_file\n" +
                "        file: .env.local\n        key: API_PORT\n" +
                "    prime_artifacts:\n      - path: .env.local\n        strategy: symlink\n",
        );
        assert.throws(
            () => loadConfig(),
            /Repo "api" prime_artifacts: symlink entry "\.env\.local".*exposes/s,
        );
    });

    // A `find` entry's matches can't be enumerated before the source repo is
    // walked, so it is deliberately left unchecked.
    it("accepts a find-addressed symlink entry that could match a consumed path", () => {
        writeFileSync(
            join(home, "default.yaml"),
            `${CONSUMER}    prime_artifacts:\n      - find: config\n        strategy: symlink\n`,
        );
        const { config } = loadConfig();
        assert.equal(config.repos.api.prime_artifacts?.[0].find, "config");
    });

    // R15: priming validation must not lock a user out of the commands that
    // inspect and tear down a group they already have on disk.
    it("still loads for inspection/teardown when only priming validation fails", () => {
        writeFileSync(
            join(home, "default.yaml"),
            primeYaml("      - path: cache\n        strategy: hardlink\n"),
        );
        assert.throws(() => loadConfig(), /unknown strategy "hardlink"/);
        const { config } = loadConfig({ tolerateInvalidPrimeArtifacts: true });
        assert.equal(config.repos.api.path, "/tmp/api");
    });

    it("still rejects non-priming errors for inspection/teardown", () => {
        writeFileSync(join(home, "default.yaml"), "version: 1\nrepos: {}\n");
        assert.throws(
            () => loadConfig({ tolerateInvalidPrimeArtifacts: true }),
            /no repos defined/,
        );
    });
});
