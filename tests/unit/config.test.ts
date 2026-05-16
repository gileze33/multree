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
});
