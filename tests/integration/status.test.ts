import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("status", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup", `echo "API_PORT=5234" > .env.local`),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "API_PORT" },
                    },
                    defaults: { port: 5000 },
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    files: { ".env": "EXISTING=keep\n" },
                    consumes: {
                        file: ".env",
                        upsert: { API_URL: "http://localhost:{api.port}" },
                    },
                },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("reports branch, ahead/behind, dirty, exposes, and resolved consumes", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        sb.advanceDevelop("api");

        const r = runMultree(sb, ["status", "g"]);
        assert.equal(r.status, 0, r.stderr);

        assert.match(r.stdout, /Group: g/);
        assert.match(r.stdout, /▸ api/);
        assert.match(r.stdout, /branch: multree\/g/);
        assert.match(r.stdout, /base: develop \(0 ahead \/ 1 behind\)/);
        assert.match(r.stdout, /exposes:/);
        assert.match(r.stdout, /port = 5234/);

        assert.match(r.stdout, /▸ frontend/);
        assert.match(r.stdout, /consumes:/);
        assert.match(r.stdout, /API_URL = http:\/\/localhost:5234/);
    });

    it("flags a dirty worktree", () => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" }],
        });
        runMultree(sb, ["create", "g", "--include", "api"]);
        writeFileSync(join(sb.worktreePath("g", "api"), "dirty.txt"), "x");

        const r = runMultree(sb, ["status", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /tree: dirty/);
    });

    it("errors when the group does not exist", () => {
        const r = runMultree(sb, ["status", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });

    // status catches resolveTemplate errors per-template and shows a
    // placeholder rather than crashing. Reaching that branch requires a
    // template that resolves at create time (so wireGroup succeeds) but is
    // broken later — easiest is to mutate the manifest after create.
    it("renders <unresolved: ...> when a consumes template references a missing key", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);

        const manifest = parse(readFileSync(sb.manifestPath, "utf-8"));
        manifest.repos.frontend.consumes.upsert.MISSING_VAL = "{api.does_not_exist}";
        writeFileSync(sb.manifestPath, stringify(manifest));

        const r = runMultree(sb, ["status", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /MISSING_VAL = <unresolved:.*does_not_exist/);
        // The healthy template alongside it still resolves.
        assert.match(r.stdout, /API_URL = http:\/\/localhost:5234/);
    });
});

// --fetch refreshes remote-tracking refs in the source repo before computing
// ahead/behind. To observe the difference we need branch_base to be a remote
// ref ("origin/develop"); local "develop" wouldn't move just from a fetch.
describe("status --fetch", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    withRemote: true,
                    branchBase: "origin/develop",
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("refreshes remote refs so ahead/behind reflects a third-party push", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);

        // Side channel: push a commit to the bare remote without going through
        // the source repo, so the source's view of origin/develop is stale
        // until something runs `git fetch` there.
        const bareRemote = join(sb.reposRoot, "fake-api.git");
        const tempClone = mkdtempSync(join(tmpdir(), "multree-external-"));
        try {
            execSync(`git clone -q "${bareRemote}" "${tempClone}"`, { stdio: "pipe" });
            // The bare repo's HEAD defaults to master (not develop) so the
            // clone lands without a checked-out branch — switch to develop
            // explicitly before committing.
            execSync(
                `git -C "${tempClone}" checkout -q -B develop origin/develop`,
                { stdio: "pipe" },
            );
            execSync(`git -C "${tempClone}" config user.email t@t`, { stdio: "pipe" });
            execSync(`git -C "${tempClone}" config user.name t`, { stdio: "pipe" });
            execSync(`git -C "${tempClone}" config commit.gpgsign false`, { stdio: "pipe" });
            execSync(
                `git -C "${tempClone}" commit --allow-empty -q -m "external advance"`,
                { stdio: "pipe" },
            );
            execSync(`git -C "${tempClone}" push -q origin develop`, { stdio: "pipe" });
        } finally {
            rmSync(tempClone, { recursive: true, force: true });
        }

        // Without --fetch, the source repo's origin/develop is still at the
        // commit it had at create time.
        const stale = runMultree(sb, ["status", "g"]);
        assert.equal(stale.status, 0, stale.stderr);
        assert.match(stale.stdout, /0 ahead \/ 0 behind/);

        // With --fetch, the new origin commit shows up as 1 behind.
        const fresh = runMultree(sb, ["status", "g", "--fetch"]);
        assert.equal(fresh.status, 0, fresh.stderr);
        assert.match(fresh.stdout, /0 ahead \/ 1 behind/);
    });
});
