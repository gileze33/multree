import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    let dir: string;
    const originalConfig = process.env.MULTREE_CONFIG;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-config-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (originalConfig === undefined) {
            delete process.env.MULTREE_CONFIG;
        } else {
            process.env.MULTREE_CONFIG = originalConfig;
        }
    });

    it("throws when MULTREE_CONFIG points at a missing file", () => {
        process.env.MULTREE_CONFIG = join(dir, "does-not-exist.yaml");
        assert.throws(() => loadConfig(), /ENOENT|no such file/i);
    });

    it("throws on an unsupported config version", () => {
        const p = join(dir, "bad-version.yaml");
        writeFileSync(p, "version: 2\nrepos:\n  api:\n    path: /tmp\n");
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /Unsupported config version/);
    });

    it("throws when no repos are defined", () => {
        const p = join(dir, "no-repos.yaml");
        writeFileSync(p, "version: 1\nrepos: {}\n");
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /no repos defined/);
    });

    it("throws when a repo is missing its path", () => {
        const p = join(dir, "no-path.yaml");
        writeFileSync(p, "version: 1\nrepos:\n  api:\n    branch_base: origin/main\n");
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /missing required field: path/);
    });

    it("loads a minimal valid manifest and returns its path", () => {
        const p = join(dir, "ok.yaml");
        writeFileSync(p, "version: 1\nrepos:\n  api:\n    path: /tmp/api\n");
        process.env.MULTREE_CONFIG = p;
        const { config, path } = loadConfig();
        assert.equal(path, p);
        assert.equal(config.version, 1);
        assert.equal(config.repos.api.path, "/tmp/api");
    });

    it("rejects depends_on pointing at an unknown repo", () => {
        const p = join(dir, "unknown-dep.yaml");
        writeFileSync(
            p,
            "version: 1\nrepos:\n  api:\n    path: /tmp/api\n  frontend:\n    path: /tmp/frontend\n    depends_on: [ghost]\n",
        );
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /depends_on unknown repo "ghost"/);
    });

    it("rejects depends_on pointing at the repo itself", () => {
        const p = join(dir, "self-dep.yaml");
        writeFileSync(
            p,
            "version: 1\nrepos:\n  api:\n    path: /tmp/api\n    depends_on: [api]\n",
        );
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /depends_on itself/);
    });

    it("rejects a depends_on cycle", () => {
        const p = join(dir, "cycle.yaml");
        writeFileSync(
            p,
            "version: 1\nrepos:\n" +
                "  a:\n    path: /tmp/a\n    depends_on: [b]\n" +
                "  b:\n    path: /tmp/b\n    depends_on: [a]\n",
        );
        process.env.MULTREE_CONFIG = p;
        assert.throws(() => loadConfig(), /depends_on cycle/);
    });

    it("accepts a valid depends_on graph", () => {
        const p = join(dir, "deps.yaml");
        writeFileSync(
            p,
            "version: 1\nrepos:\n" +
                "  api:\n    path: /tmp/api\n" +
                "  frontend:\n    path: /tmp/frontend\n    depends_on: [api]\n",
        );
        process.env.MULTREE_CONFIG = p;
        const { config } = loadConfig();
        assert.deepEqual(config.repos.frontend.depends_on, ["api"]);
    });
});
