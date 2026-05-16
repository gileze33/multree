import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

describe("rewire", () => {
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
                    setup: trace("frontend:setup"),
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

    it("is idempotent across repeated invocations", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const envPath = join(sb.worktreePath("g", "frontend"), ".env");
        const first = readFileSync(envPath, "utf-8");

        runMultree(sb, ["rewire", "g"]);
        const second = readFileSync(envPath, "utf-8");
        assert.equal(first, second, "first rewire should be a no-op when nothing changed");

        runMultree(sb, ["rewire", "g"]);
        const third = readFileSync(envPath, "utf-8");
        assert.equal(second, third, "second rewire should be a no-op when nothing changed");
    });

    it("picks up a changed exposed value on the next rewire", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);

        // Simulate the api repo updating its port (e.g. dev changed config).
        writeFileSync(join(sb.worktreePath("g", "api"), ".env.local"), "API_PORT=5999\n");

        const r = runMultree(sb, ["rewire", "g"]);
        assert.equal(r.status, 0, r.stderr);

        const env = readFileSync(join(sb.worktreePath("g", "frontend"), ".env"), "utf-8");
        assert.match(env, /API_URL=http:\/\/localhost:5999/);
        assert.match(env, /EXISTING=keep/);
    });

    it("preserves user-written env keys outside the managed block", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        const envPath = join(sb.worktreePath("g", "frontend"), ".env");

        // Dev adds a personal override after the managed block.
        const original = readFileSync(envPath, "utf-8");
        writeFileSync(envPath, `${original}\nPERSONAL=mine\n`);

        runMultree(sb, ["rewire", "g"]);
        const after = readFileSync(envPath, "utf-8");
        assert.match(after, /PERSONAL=mine/);
        assert.match(after, /EXISTING=keep/);
        assert.match(after, /# >>> multree-managed: g >>>/);
    });

    it("errors when the group does not exist", () => {
        const r = runMultree(sb, ["rewire", "ghost"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: ghost/);
    });
});
