import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("create --from", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    branches: ["feature-x", "api-other"],
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    branches: ["feature-x", "frontend-other"],
                },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("bases each member's worktree on the given existing branch", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api,frontend",
            "--from",
            "feature-x",
        ]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);

        const state = sb.state("g");
        assert.ok(state);
        assert.equal(state!.branch, "feature-x");
        assert.equal(state!.members.api.branch, "feature-x");
        assert.equal(state!.members.frontend.branch, "feature-x");

        const apiHead = sb
            .gitInRepo("api", `-C ${sb.worktreePath("g", "api")} rev-parse --abbrev-ref HEAD`)
            .trim();
        const frontHead = sb
            .gitInRepo("frontend", `-C ${sb.worktreePath("g", "frontend")} rev-parse --abbrev-ref HEAD`)
            .trim();
        assert.equal(apiHead, "feature-x");
        assert.equal(frontHead, "feature-x");
    });

    it("honours per-repo branch overrides", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api,frontend",
            "--from",
            "feature-x",
            "--from-api",
            "api-other",
            "--from-frontend",
            "frontend-other",
        ]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);

        const state = sb.state("g");
        assert.equal(state!.members.api.branch, "api-other");
        assert.equal(state!.members.frontend.branch, "frontend-other");
    });

    it("rejects --from-<repo> when repo is not included", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
            "--from-frontend",
            "frontend-other",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not in --include/);
    });

    it("errors when --from branch does not exist", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "does-not-exist",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not found locally or on origin/);
    });

    it("refuses if the branch is already checked out in another worktree", () => {
        // Force the source repo's main checkout onto feature-x so multree's
        // worktree-add must compete for the same branch.
        sb.gitInRepo("api", "checkout -q feature-x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /already checked out/);
    });

    it("rejects --from with --branch", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
            "--branch",
            "other",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /mutually exclusive/);
    });
});
