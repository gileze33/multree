import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("update", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("rebases base into each member's branch by default", () => {
        const create = runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        assert.equal(create.status, 0, create.stderr);

        sb.advanceDevelop("api", "api-new");
        sb.advanceDevelop("frontend", "frontend-new");

        const r = runMultree(sb, ["update", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(rebase\)/);
        assert.match(r.stdout, /✓ frontend \(rebase\)/);

        // After rebase, develop is reachable from each worktree's HEAD.
        for (const key of ["api", "frontend"]) {
            const out = sb.gitInRepo(
                key,
                `-C ${sb.worktreePath("g", key)} merge-base --is-ancestor develop HEAD; echo $?`,
            ).trim();
            assert.equal(out, "0", `develop should be ancestor of HEAD in ${key}`);
        }
    });

    it("merges when --strategy merge is given", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        sb.advanceDevelop("api", "ahead");

        const r = runMultree(sb, ["update", "g", "--strategy", "merge"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(merge\)/);
    });

    it("skips members with a dirty working tree and reports them", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        sb.advanceDevelop("api");

        // Dirty up the api worktree.
        writeFileSync(join(sb.worktreePath("g", "api"), "dirty.txt"), "x");

        const r = runMultree(sb, ["update", "g"]);
        // No failures occurred; status should still be 0.
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /api: skipped \(dirty working tree\)/);
        assert.match(r.stdout, /✓ frontend/);
    });

    it("rejects an invalid --strategy value", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["update", "g", "--strategy", "squash"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Invalid --strategy/);
    });

    it("manifest-level update_strategy overrides the built-in default", () => {
        sb = createSandbox({
            updateStrategy: "merge",
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        sb.advanceDevelop("api");
        sb.advanceDevelop("frontend");

        const r = runMultree(sb, ["update", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(merge\)/);
        assert.match(r.stdout, /✓ frontend \(merge\)/);
    });

    it("per-repo update_strategy overrides the manifest-level default", () => {
        // Manifest default is "merge"; api is explicitly "rebase".
        sb = createSandbox({
            updateStrategy: "merge",
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    updateStrategy: "rebase",
                },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        sb.advanceDevelop("api");
        sb.advanceDevelop("frontend");

        const r = runMultree(sb, ["update", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(rebase\)/);
        assert.match(r.stdout, /✓ frontend \(merge\)/);
    });
});
