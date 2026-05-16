import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// When a producer is in the group but its declared expose key is missing from
// the env file, the consumer must fall back to the producer's defaults rather
// than crashing or writing the literal template string.

describe("expose key missing from producer env file", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    // Setup writes a *different* key — port is never produced.
                    setup: trace("api:setup", `echo "other=value" > .env.local`),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "API_PORT" },
                    },
                    defaults: { port: 5000 },
                },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    setup: trace("frontend:setup"),
                    consumes: {
                        file: ".env",
                        upsert: { API_URL: "http://localhost:{api.port}" },
                    },
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("falls back to the producer's default value", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api,frontend"]);
        assert.equal(r.status, 0, r.stderr);

        const env = readFileSync(join(sb.worktreePath("g", "frontend"), ".env"), "utf-8");
        assert.match(env, /API_URL=http:\/\/localhost:5000/);
        assert.doesNotMatch(env, /\{api\.port\}/);
    });
});
