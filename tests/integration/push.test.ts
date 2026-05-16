import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("push", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", withRemote: true },
                { key: "frontend", dirname: "fake-frontend", withRemote: true },
                { key: "readonly", dirname: "fake-ro", withRemote: true, push: false },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("pushes each member's branch to origin (and sets upstream on first push)", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(multree\/g\)/);
        assert.match(r.stdout, /✓ frontend \(multree\/g\)/);

        assert.ok(sb.remoteHasBranch("api", "multree/g"));
        assert.ok(sb.remoteHasBranch("frontend", "multree/g"));
    });

    it("skips repos with push: false", () => {
        runMultree(sb, ["create", "g", "--include", "api,readonly"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /readonly: skipped \(push: false\)/);
        assert.match(r.stdout, /✓ api/);
        assert.equal(sb.remoteHasBranch("readonly", "multree/g"), false);
    });

    it("reports a non-zero exit when any push fails", () => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" /* no remote */ }],
        });
        runMultree(sb, ["create", "g", "--include", "api"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stdout, /✗ api: push failed/);
    });

    // Re-pushing with explicit --set-upstream on a branch whose upstream is
    // already configured must not error (git would reject a duplicate -u
    // only if the value differed; here it matches, so it's a no-op).
    it("accepts explicit --set-upstream on a branch already tracking origin", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        // First push auto-sets upstream.
        const first = runMultree(sb, ["push", "g"]);
        assert.equal(first.status, 0, first.stderr);

        const second = runMultree(sb, ["push", "g", "--set-upstream"]);
        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /✓ api \(multree\/g\)/);
    });

    it("errors when the group does not exist", () => {
        const r = runMultree(sb, ["push", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });

    // currentBranch returns null on a detached worktree, so push falls back
    // to the recorded member.branch. The local ref "multree/g" still points
    // at the same commit (detach only moves HEAD), so the push targets the
    // right branch on the remote rather than literally pushing "HEAD".
    it("pushes the recorded branch when the worktree HEAD is detached", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const wt = sb.worktreePath("g", "api");
        execSync(`git -C "${wt}" switch -q --detach`, { stdio: "pipe" });

        const r = runMultree(sb, ["push", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(multree\/g\)/);
        assert.ok(sb.remoteHasBranch("api", "multree/g"));
    });
});
