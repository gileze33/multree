import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandPath, loadConfig, resolveBranchBase } from "../../src/config.ts";

describe("expandPath", () => {
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
    const savedConfig = process.env.MULTREE_CONFIG;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-config-"));
        mkdirSync(home, { recursive: true });
        process.env.MULTREE_HOME = home;
        delete process.env.MULTREE_PROFILE;
        delete process.env.MULTREE_CONFIG;
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
        if (savedConfig === undefined) {
            delete process.env.MULTREE_CONFIG;
        } else {
            process.env.MULTREE_CONFIG = savedConfig;
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
