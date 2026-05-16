import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("create + destroy (happy path)", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup", `echo "API_PORT=5234" > .env.local`),
                    teardown: trace("api:teardown"),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "API_PORT" },
                    },
                    defaults: { port: 5000 },
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    setup: trace("frontend:setup"),
                    teardown: trace("frontend:teardown"),
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

    it("creates worktrees, runs setup, wires env, persists state", () => {
        const result = runMultree(sb, ["create", "demo", "--include", "api,frontend"]);
        assert.equal(result.status, 0, `non-zero exit\n${result.stderr}`);

        const state = sb.state("demo");
        assert.ok(state, "state file not written");
        assert.deepEqual(Object.keys(state!.members), ["api", "frontend"]);
        assert.equal(state!.members.api.exposes.port, "5234");

        assert.ok(existsSync(sb.worktreePath("demo", "api")), "api worktree missing");
        assert.ok(existsSync(sb.worktreePath("demo", "frontend")), "frontend worktree missing");

        const frontendEnv = readFileSync(join(sb.worktreePath("demo", "frontend"), ".env"), "utf-8");
        assert.match(frontendEnv, /EXISTING=keep/);
        assert.match(frontendEnv, /API_URL=http:\/\/localhost:5234/);
        assert.match(frontendEnv, /# >>> multree-managed: demo >>>/);

        assert.deepEqual(sb.trace(), ["api:setup", "frontend:setup"]);
    });

    it("destroy removes worktrees, runs teardown, deletes state", () => {
        runMultree(sb, ["create", "demo", "--include", "api,frontend"]);
        const r = runMultree(sb, ["destroy", "demo"]);
        assert.equal(r.status, 0, `destroy exit non-zero\n${r.stderr}`);

        assert.equal(existsSync(join(sb.worktreeRoot, "demo")), false);
        assert.equal(sb.state("demo"), null);
        const events = sb.trace();
        assert.ok(events.includes("api:teardown"));
        assert.ok(events.includes("frontend:teardown"));
    });

    it("frontends without api in the group fall back to defaults", () => {
        const r = runMultree(sb, ["create", "solo", "--include", "frontend"]);
        assert.equal(r.status, 0, r.stderr);

        const frontendEnv = readFileSync(join(sb.worktreePath("solo", "frontend"), ".env"), "utf-8");
        assert.match(frontendEnv, /API_URL=http:\/\/localhost:5000/);
    });
});
