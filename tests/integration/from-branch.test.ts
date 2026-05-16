import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

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

    it("errors when --from branch does not exist (and creates no worktrees)", () => {
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
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
    });

    it("pre-flight aborts the whole create if a single member's --from is missing", () => {
        // Replace the default sandbox with one where only api has feature-x.
        sb.cleanup();
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    branches: ["feature-x"],
                    setup: trace("api:setup"),
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    setup: trace("frontend:setup"),
                },
            ],
        });

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api,frontend",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /create aborted/);
        assert.match(r.stderr, /\[frontend\] --from branch "feature-x" not found/);

        // No worktrees, no group state, no hooks fired -- even for the
        // repo whose pre-flight passed.
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
        assert.deepEqual(sb.trace(), []);
    });

    it("pre-flight aggregates multiple member failures into one error", () => {
        sb.cleanup();
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api,frontend",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /2 members failed pre-flight/);
        assert.match(r.stderr, /\[api\] --from branch "feature-x" not found/);
        assert.match(r.stderr, /\[frontend\] --from branch "feature-x" not found/);
    });

    it("refuses if the branch is held by another (non-main) worktree", () => {
        // Spin up an unrelated worktree of the api source repo on feature-x
        // so the main checkout still owns develop -- the conflict here is
        // with another worktree, not the main checkout.
        const externalWt = join(sb.root, "external-feature-x");
        sb.gitInRepo("api", `worktree add "${externalWt}" feature-x`);
        assert.ok(existsSync(externalWt));

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /already checked out in another worktree/);
    });

    it("default main_checkout_action=switch frees a branch from the main checkout", () => {
        // Main checkout currently sits on feature-x; default action is to
        // switch it back to branch_base (develop), then claim the branch.
        sb.gitInRepo("api", "checkout -q feature-x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);
        assert.match(r.stdout, /freeing branch "feature-x" from main checkout: switching to "develop"/);

        // Main source is back on develop.
        const mainHead = sb.gitInRepo("api", "rev-parse --abbrev-ref HEAD").trim();
        assert.equal(mainHead, "develop");

        // Worktree owns feature-x.
        const wtHead = sb
            .gitInRepo("api", `-C ${sb.worktreePath("g", "api")} rev-parse --abbrev-ref HEAD`)
            .trim();
        assert.equal(wtHead, "feature-x");
    });

    it("manifest-level main_checkout_action flows through when no per-repo override is set", () => {
        // Top-level main_checkout_action=detach should apply to api even
        // though api has no per-repo override.
        sb = createSandbox({
            mainCheckoutAction: "detach",
            repos: [
                { key: "api", dirname: "fake-api", branches: ["feature-x"] },
            ],
        });
        sb.gitInRepo("api", "checkout -q feature-x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);
        assert.match(r.stdout, /detaching HEAD/);
        const mainHead = sb.gitInRepo("api", "rev-parse --abbrev-ref HEAD").trim();
        assert.equal(mainHead, "HEAD");
    });

    it("per-repo main_checkout_action overrides the manifest-level setting", () => {
        // Manifest says "detach" but api overrides to "error".
        sb = createSandbox({
            mainCheckoutAction: "detach",
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    branches: ["feature-x"],
                    mainCheckoutAction: "error",
                },
            ],
        });
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
        assert.match(r.stderr, /held by the main checkout/);
    });

    it("main_checkout_action=detach leaves the main checkout on a detached HEAD", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    branches: ["feature-x"],
                    mainCheckoutAction: "detach",
                },
            ],
        });
        sb.gitInRepo("api", "checkout -q feature-x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);
        assert.match(r.stdout, /detaching HEAD/);

        // HEAD is detached: rev-parse --abbrev-ref HEAD returns "HEAD".
        const mainHead = sb.gitInRepo("api", "rev-parse --abbrev-ref HEAD").trim();
        assert.equal(mainHead, "HEAD");
    });

    it("main_checkout_action=error refuses to touch the main checkout", () => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    branches: ["feature-x"],
                    mainCheckoutAction: "error",
                },
            ],
        });
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
        assert.match(r.stderr, /held by the main checkout/);
    });

    it("refuses when the main checkout is dirty (default switch action)", () => {
        sb.gitInRepo("api", "checkout -q feature-x");
        writeFileSync(join(sb.repoPath("api"), "dirty.txt"), "x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /main checkout at .* is dirty/);
    });

    it("a dirty main checkout in one repo aborts the whole multi-repo create", () => {
        // api is clean and on feature-x; frontend is dirty on feature-x. We
        // expect the whole create to abort -- api must NOT get a worktree.
        sb.gitInRepo("frontend", "checkout -q feature-x");
        writeFileSync(join(sb.repoPath("frontend"), "dirty.txt"), "x");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api,frontend",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /\[frontend\] main checkout at .* is dirty/);
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
    });

    it("main_checkout_action=switch fails pre-flight if the default branch was deleted locally", () => {
        sb.cleanup();
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api", branches: ["feature-x"] }],
        });
        // Move off develop so we can delete it, then leave the main checkout
        // on feature-x to trigger the release plan.
        sb.gitInRepo("api", "checkout -q feature-x");
        sb.gitInRepo("api", "branch -D develop");

        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "api",
            "--from",
            "feature-x",
        ]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /local branch "develop" doesn't exist/);
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
