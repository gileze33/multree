import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { primeArtifacts } from "../../src/artifacts.ts";

describe("primeArtifacts (copy strategy)", () => {
    let root: string;
    let src: string;
    let dst: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-artifacts-"));
        src = join(root, "src");
        dst = join(root, "dst");
        mkdirSync(src, { recursive: true });
        mkdirSync(dst, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("is a no-op for empty specs", () => {
        primeArtifacts(src, dst, undefined);
        primeArtifacts(src, dst, []);
        assert.deepEqual([...readDirSafe(dst)], []);
    });

    it("copies a single path directory recursively", () => {
        const nm = join(src, "node_modules");
        mkdirSync(join(nm, "pkg"), { recursive: true });
        writeFileSync(join(nm, "pkg", "index.js"), "module.exports = 1;");

        primeArtifacts(src, dst, [{ path: "node_modules", strategy: "copy" }]);

        const copied = join(dst, "node_modules", "pkg", "index.js");
        assert.equal(existsSync(copied), true);
        assert.equal(readFileSync(copied, "utf-8"), "module.exports = 1;");
    });

    it("finds nested paths by basename via 'find'", () => {
        mkdirSync(join(src, "packages", "a", "node_modules"), { recursive: true });
        mkdirSync(join(src, "packages", "b", "node_modules"), { recursive: true });
        writeFileSync(join(src, "packages", "a", "node_modules", "marker"), "a");
        writeFileSync(join(src, "packages", "b", "node_modules", "marker"), "b");

        primeArtifacts(src, dst, [{ find: "node_modules", strategy: "copy" }]);

        assert.equal(readFileSync(join(dst, "packages", "a", "node_modules", "marker"), "utf-8"), "a");
        assert.equal(readFileSync(join(dst, "packages", "b", "node_modules", "marker"), "utf-8"), "b");
    });

    it("skips destinations that already exist", () => {
        mkdirSync(join(src, "node_modules"), { recursive: true });
        writeFileSync(join(src, "node_modules", "marker"), "from-src");
        mkdirSync(join(dst, "node_modules"), { recursive: true });
        writeFileSync(join(dst, "node_modules", "marker"), "from-dst");

        primeArtifacts(src, dst, [{ path: "node_modules", strategy: "copy" }]);

        assert.equal(readFileSync(join(dst, "node_modules", "marker"), "utf-8"), "from-dst");
    });

    it("does not fail when source path is missing", () => {
        primeArtifacts(src, dst, [{ path: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });

    it("defaults to 'copy' strategy when unspecified", () => {
        mkdirSync(join(src, "out"), { recursive: true });
        writeFileSync(join(src, "out", "marker"), "x");
        primeArtifacts(src, dst, [{ path: "out" }]);
        assert.equal(existsSync(join(dst, "out", "marker")), true);
    });

    it("rejects a spec with both 'path' and 'find'", () => {
        assert.throws(() => primeArtifacts(src, dst, [{ path: "a", find: "b" }]), /either 'path' or 'find'/);
    });

    it("rejects a spec with neither 'path' nor 'find'", () => {
        assert.throws(() => primeArtifacts(src, dst, [{ strategy: "copy" }]), /must specify 'path' or 'find'/);
    });

    it("is a no-op when 'find' matches nothing in the source", () => {
        mkdirSync(join(src, "irrelevant"), { recursive: true });
        primeArtifacts(src, dst, [{ find: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });

    it("'find' keeps each match's original relative location", () => {
        mkdirSync(join(src, "deep", "nested", "node_modules"), { recursive: true });
        writeFileSync(join(src, "deep", "nested", "node_modules", "marker"), "x");

        primeArtifacts(src, dst, [{ find: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "deep", "nested", "node_modules", "marker")), true);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });
});

function readDirSafe(p: string): string[] {
    try {
        return require("node:fs").readdirSync(p);
    } catch {
        return [];
    }
}
