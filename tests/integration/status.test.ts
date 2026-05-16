import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
});
