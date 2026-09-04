import { strict as assert } from "node:assert";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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
        primeArtifacts("api", src, dst, undefined);
        primeArtifacts("api", src, dst, []);
        assert.deepEqual([...readDirSafe(dst)], []);
    });

    it("copies a single path directory recursively", () => {
        const nm = join(src, "node_modules");
        mkdirSync(join(nm, "pkg"), { recursive: true });
        writeFileSync(join(nm, "pkg", "index.js"), "module.exports = 1;");

        primeArtifacts("api", src, dst, [{ path: "node_modules", strategy: "copy" }]);

        const copied = join(dst, "node_modules", "pkg", "index.js");
        assert.equal(existsSync(copied), true);
        assert.equal(readFileSync(copied, "utf-8"), "module.exports = 1;");
    });

    it("finds nested paths by basename via 'find'", () => {
        mkdirSync(join(src, "packages", "a", "node_modules"), { recursive: true });
        mkdirSync(join(src, "packages", "b", "node_modules"), { recursive: true });
        writeFileSync(join(src, "packages", "a", "node_modules", "marker"), "a");
        writeFileSync(join(src, "packages", "b", "node_modules", "marker"), "b");

        primeArtifacts("api", src, dst, [{ find: "node_modules", strategy: "copy" }]);

        assert.equal(readFileSync(join(dst, "packages", "a", "node_modules", "marker"), "utf-8"), "a");
        assert.equal(readFileSync(join(dst, "packages", "b", "node_modules", "marker"), "utf-8"), "b");
    });

    it("skips destinations that already exist", () => {
        mkdirSync(join(src, "node_modules"), { recursive: true });
        writeFileSync(join(src, "node_modules", "marker"), "from-src");
        mkdirSync(join(dst, "node_modules"), { recursive: true });
        writeFileSync(join(dst, "node_modules", "marker"), "from-dst");

        primeArtifacts("api", src, dst, [{ path: "node_modules", strategy: "copy" }]);

        assert.equal(readFileSync(join(dst, "node_modules", "marker"), "utf-8"), "from-dst");
    });

    it("does not fail when source path is missing", () => {
        primeArtifacts("api", src, dst, [{ path: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });

    it("defaults to 'copy' strategy when unspecified", () => {
        mkdirSync(join(src, "out"), { recursive: true });
        writeFileSync(join(src, "out", "marker"), "x");
        primeArtifacts("api", src, dst, [{ path: "out" }]);
        assert.equal(existsSync(join(dst, "out", "marker")), true);
    });

    it("rejects a spec with both 'path' and 'find'", () => {
        assert.throws(() => primeArtifacts("api", src, dst, [{ path: "a", find: "b" }]), /either 'path' or 'find'/);
    });

    it("rejects a spec with neither 'path' nor 'find'", () => {
        assert.throws(() => primeArtifacts("api", src, dst, [{ strategy: "copy" }]), /must specify 'path' or 'find'/);
    });

    it("is a no-op when 'find' matches nothing in the source", () => {
        mkdirSync(join(src, "irrelevant"), { recursive: true });
        primeArtifacts("api", src, dst, [{ find: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });

    it("'find' keeps each match's original relative location", () => {
        mkdirSync(join(src, "deep", "nested", "node_modules"), { recursive: true });
        writeFileSync(join(src, "deep", "nested", "node_modules", "marker"), "x");

        primeArtifacts("api", src, dst, [{ find: "node_modules", strategy: "copy" }]);
        assert.equal(existsSync(join(dst, "deep", "nested", "node_modules", "marker")), true);
        assert.equal(existsSync(join(dst, "node_modules")), false);
    });

    // Regression: artifacts used to shell-interpolate the find pattern and
    // src/dst paths, so a `$` in a name would expand to an empty variable and
    // silently miss the directory. Argv-form invocation passes them literally.
    it("'find' handles a basename containing a $ character", () => {
        const weird = "node$modules";
        mkdirSync(join(src, "packages", "a", weird), { recursive: true });
        writeFileSync(join(src, "packages", "a", weird, "marker"), "ok");
        primeArtifacts("api", src, dst, [{ find: weird, strategy: "copy" }]);
        assert.equal(
            readFileSync(join(dst, "packages", "a", weird, "marker"), "utf-8"),
            "ok",
        );
    });

    // Regression: a dangling link at the destination used to read as absent to
    // `copy`/`reflink`'s existence check, and the cpSync that followed aborted
    // the whole process with a native exception no try/catch could hold. The
    // occupancy test is lstat-based for every strategy, so it is now a skip.
    for (const strategy of ["copy", "reflink"] as const) {
        it(`leaves a dangling destination link in place under ${strategy}`, () => {
            mkdirSync(join(src, "out"), { recursive: true });
            writeFileSync(join(src, "out", "marker"), "x");
            symlinkSync(join(root, "gone"), join(dst, "out"));

            primeArtifacts("api", src, dst, [{ path: "out", strategy }]);

            assert.equal(lstatSync(join(dst, "out")).isSymbolicLink(), true);
            assert.equal(readlinkSync(join(dst, "out")), join(root, "gone"));
        });
    }

    it("'path' handles a directory name containing a $ character", () => {
        const weird = "out$dir";
        mkdirSync(join(src, weird), { recursive: true });
        writeFileSync(join(src, weird, "marker"), "ok");
        primeArtifacts("api", src, dst, [{ path: weird, strategy: "copy" }]);
        assert.equal(readFileSync(join(dst, weird, "marker"), "utf-8"), "ok");
    });
});

// `symlink` points the worktree path at the corresponding path in the repo's
// main checkout, so reads and writes through it resolve there rather than
// duplicating the tree.
describe("primeArtifacts (symlink strategy)", () => {
    let root: string;
    let src: string;
    let dst: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-symlink-"));
        src = join(root, "src");
        dst = join(root, "dst");
        mkdirSync(src, { recursive: true });
        mkdirSync(dst, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("links the worktree path at its counterpart in the main checkout", () => {
        writeFileSync(join(src, "config.local"), "shared\n");

        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);

        const link = join(dst, "config.local");
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        assert.equal(readlinkSync(link), join(src, "config.local"));
        assert.equal(readFileSync(link, "utf-8"), "shared\n");
    });

    it("makes a write through the link visible in the main checkout", () => {
        writeFileSync(join(src, "config.local"), "before\n");
        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);

        writeFileSync(join(dst, "config.local"), "after\n");

        assert.equal(readFileSync(join(src, "config.local"), "utf-8"), "after\n");
    });

    // AE3.
    it("skips a source the main checkout does not have, without erroring", () => {
        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);
        assert.equal(existsSync(join(dst, "config.local")), false);
    });

    it("leaves a destination already holding a regular file untouched", () => {
        writeFileSync(join(src, "config.local"), "from-src\n");
        writeFileSync(join(dst, "config.local"), "from-dst\n");

        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);

        assert.equal(lstatSync(join(dst, "config.local")).isSymbolicLink(), false);
        assert.equal(readFileSync(join(dst, "config.local"), "utf-8"), "from-dst\n");
    });

    // AE4: a dangling link reads as absent to a plain existence check, so
    // re-priming would try to create over it and throw. Occupancy for symlink
    // is lstat-based instead.
    it("leaves a dangling destination link in place and raises no error", () => {
        writeFileSync(join(src, "config.local"), "shared\n");
        symlinkSync(join(root, "gone"), join(dst, "config.local"));

        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);

        assert.equal(readlinkSync(join(dst, "config.local")), join(root, "gone"));
    });

    it("re-priming an already-linked worktree changes nothing", () => {
        writeFileSync(join(src, "config.local"), "shared\n");
        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);
        primeArtifacts("api", src, dst, [{ path: "config.local", strategy: "symlink" }]);

        assert.equal(readlinkSync(join(dst, "config.local")), join(src, "config.local"));
    });

    it("creates missing parent directories for a nested destination", () => {
        mkdirSync(join(src, "deep", "nested"), { recursive: true });
        writeFileSync(join(src, "deep", "nested", "config.local"), "shared\n");

        primeArtifacts("api", src, dst, [
            { path: "deep/nested/config.local", strategy: "symlink" },
        ]);

        assert.equal(
            readlinkSync(join(dst, "deep", "nested", "config.local")),
            join(src, "deep", "nested", "config.local"),
        );
    });

    it("links every directory a 'find' entry matches", () => {
        mkdirSync(join(src, "packages", "a", "shared"), { recursive: true });
        mkdirSync(join(src, "packages", "b", "shared"), { recursive: true });
        writeFileSync(join(src, "packages", "a", "shared", "marker"), "a");
        writeFileSync(join(src, "packages", "b", "shared", "marker"), "b");

        primeArtifacts("api", src, dst, [{ find: "shared", strategy: "symlink" }]);

        for (const pkg of ["a", "b"]) {
            const link = join(dst, "packages", pkg, "shared");
            assert.equal(lstatSync(link).isSymbolicLink(), true);
            assert.equal(readFileSync(join(link, "marker"), "utf-8"), pkg);
        }
    });

    it("links a directory so its contents resolve through the link", () => {
        mkdirSync(join(src, "shared"), { recursive: true });
        writeFileSync(join(src, "shared", "marker"), "x");

        primeArtifacts("api", src, dst, [{ path: "shared", strategy: "symlink" }]);

        writeFileSync(join(dst, "shared", "added"), "y");
        assert.equal(readFileSync(join(src, "shared", "added"), "utf-8"), "y");
    });
});

function readDirSafe(p: string): string[] {
    try {
        return require("node:fs").readdirSync(p);
    } catch {
        return [];
    }
}
