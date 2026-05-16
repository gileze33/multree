import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("add and remove", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup", `echo "server__port=5234" > .env.local`),
                    teardown: trace("api:teardown"),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "server__port" },
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

    it("adds a repo and re-wires the existing members", () => {
        runMultree(sb, ["create", "g", "--include", "frontend"]);

        // Without api, frontend points at default port.
        const before = readFileSync(join(sb.worktreePath("g", "frontend"), ".env"), "utf-8");
        assert.match(before, /API_URL=http:\/\/localhost:5000/);

        const r = runMultree(sb, ["add", "g", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const state = sb.state("g");
        assert.ok(state?.members.api);
        assert.equal(state!.members.api.exposes.port, "5234");

        // Frontend has been re-wired to point at the api's actual port.
        const after = readFileSync(join(sb.worktreePath("g", "frontend"), ".env"), "utf-8");
        assert.match(after, /API_URL=http:\/\/localhost:5234/);
        assert.doesNotMatch(after, /API_URL=http:\/\/localhost:5000/);
    });

    it("removes a repo, runs its teardown, and re-wires remainder back to defaults", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const r = runMultree(sb, ["remove", "g", "api"]);
        assert.equal(r.status, 0, r.stderr);

        assert.ok(sb.trace().includes("api:teardown"));
        assert.equal(existsSync(sb.worktreePath("g", "api")), false);

        const state = sb.state("g");
        assert.equal(state?.members.api, undefined);
        assert.ok(state?.members.frontend);

        const env = readFileSync(join(sb.worktreePath("g", "frontend"), ".env"), "utf-8");
        assert.match(env, /API_URL=http:\/\/localhost:5000/);
    });

    it("rejects adding a repo that's already in the group", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["add", "g", "api"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /already in group/);
    });

    it("rejects removing a repo that isn't in the group", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["remove", "g", "frontend"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not in group/);
    });
});
