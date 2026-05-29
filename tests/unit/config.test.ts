import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandPath, loadConfig, resolveBranchBase } from "../../src/config.ts";

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
});
