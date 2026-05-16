import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteGroupDir, groupDir, listGroups, loadGroup, saveGroup } from "../../src/state.ts";
import type { GroupState, MultreeConfig } from "../../src/types.ts";

function makeConfig(worktreeRoot: string): MultreeConfig {
    return {
        version: 1,
        worktree_root: worktreeRoot,
        repos: { api: { path: "/tmp/api" } },
    };
}

function makeState(name: string, createdAt: string): GroupState {
    return {
        name,
        branch: `multree/${name}`,
        created_at: createdAt,
        members: { api: { repo: "api", path: `/tmp/${name}/api`, exposes: {} } },
    };
}

describe("groupDir", () => {
    it("rejects names with path separators", () => {
        const cfg = makeConfig("/tmp/wt");
        assert.throws(() => groupDir(cfg, "evil/../escape"), /Invalid group name/);
    });

    it("rejects names with shell metacharacters", () => {
        const cfg = makeConfig("/tmp/wt");
        assert.throws(() => groupDir(cfg, "a b"), /Invalid group name/);
        assert.throws(() => groupDir(cfg, "a;b"), /Invalid group name/);
    });

    it("accepts alphanumerics, dot, underscore, hyphen", () => {
        const cfg = makeConfig("/tmp/wt");
        assert.equal(groupDir(cfg, "feature.1_test-x"), "/tmp/wt/feature.1_test-x");
    });
});

describe("saveGroup / loadGroup", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-state-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("round-trips a state object", () => {
        const cfg = makeConfig(root);
        const original = makeState("g", "2026-05-16T10:00:00Z");
        saveGroup(cfg, original);
        const loaded = loadGroup(cfg, "g");
        assert.deepEqual(loaded, original);
    });

    it("returns null when no state file exists", () => {
        const cfg = makeConfig(root);
        assert.equal(loadGroup(cfg, "nonexistent"), null);
    });

    it("creates the group directory on save", () => {
        const cfg = makeConfig(root);
        const s = makeState("g", "2026-05-16T10:00:00Z");
        saveGroup(cfg, s);
        assert.ok(existsSync(join(root, "g", ".multree.json")));
    });
});

describe("listGroups", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-state-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("returns [] when the worktree root doesn't exist", () => {
        const cfg = makeConfig(join(root, "does-not-exist"));
        assert.deepEqual(listGroups(cfg), []);
    });

    it("returns [] for an empty worktree root", () => {
        const cfg = makeConfig(root);
        assert.deepEqual(listGroups(cfg), []);
    });

    it("skips directories without a .multree.json", () => {
        const cfg = makeConfig(root);
        mkdirSync(join(root, "stranger"));
        writeFileSync(join(root, "stranger", "random.txt"), "hi");
        saveGroup(cfg, makeState("g", "2026-05-16T10:00:00Z"));
        const groups = listGroups(cfg);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].name, "g");
    });

    it("sorts groups by created_at ascending", () => {
        const cfg = makeConfig(root);
        saveGroup(cfg, makeState("later", "2026-05-16T11:00:00Z"));
        saveGroup(cfg, makeState("earlier", "2026-05-16T09:00:00Z"));
        saveGroup(cfg, makeState("middle", "2026-05-16T10:00:00Z"));
        const groups = listGroups(cfg);
        assert.deepEqual(
            groups.map(g => g.name),
            ["earlier", "middle", "later"],
        );
    });
});

describe("saveGroup atomicity", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-state-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("leaves no .multree.json.tmp behind after a successful save", () => {
        const cfg = makeConfig(root);
        saveGroup(cfg, makeState("g", "2026-05-16T10:00:00Z"));
        assert.equal(existsSync(join(root, "g", ".multree.json.tmp")), false);
        assert.equal(existsSync(join(root, "g", ".multree.json")), true);
    });

    it("overwrites a stale .multree.json.tmp left from a prior crashed save", () => {
        const cfg = makeConfig(root);
        mkdirSync(join(root, "g"), { recursive: true });
        // Plant garbage as if a previous run died mid-write.
        writeFileSync(join(root, "g", ".multree.json.tmp"), "{garbage");
        saveGroup(cfg, makeState("g", "2026-05-16T10:00:00Z"));
        assert.equal(existsSync(join(root, "g", ".multree.json.tmp")), false);
        const loaded = loadGroup(cfg, "g");
        assert.equal(loaded?.name, "g");
    });

    it("loadGroup discards an orphan .multree.json.tmp when canonical state exists", () => {
        // Simulates a crash after writeFileSync(tmp) but before rename — the
        // canonical file is still the previous committed state and resume
        // must run against it, not the half-written tmp.
        const cfg = makeConfig(root);
        saveGroup(cfg, makeState("g", "2026-05-16T10:00:00Z"));
        writeFileSync(join(root, "g", ".multree.json.tmp"), '{"partial": true}');
        const loaded = loadGroup(cfg, "g");
        assert.equal(loaded?.name, "g");
        assert.equal(existsSync(join(root, "g", ".multree.json.tmp")), false);
    });

    it("loadGroup discards an orphan .multree.json.tmp when canonical state is missing", () => {
        // A crash before the first successful rename: canonical file never
        // existed; tmp is junk. loadGroup must return null and clean up.
        const cfg = makeConfig(root);
        mkdirSync(join(root, "g"), { recursive: true });
        writeFileSync(join(root, "g", ".multree.json.tmp"), '{"partial": true}');
        const loaded = loadGroup(cfg, "g");
        assert.equal(loaded, null);
        assert.equal(existsSync(join(root, "g", ".multree.json.tmp")), false);
    });
});

describe("deleteGroupDir", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "multree-state-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("removes the group directory", () => {
        const cfg = makeConfig(root);
        saveGroup(cfg, makeState("g", "2026-05-16T10:00:00Z"));
        assert.ok(existsSync(join(root, "g")));
        deleteGroupDir(cfg, "g");
        assert.equal(existsSync(join(root, "g")), false);
    });

    it("is a no-op when the group directory doesn't exist", () => {
        const cfg = makeConfig(root);
        deleteGroupDir(cfg, "never-created");
    });
});
