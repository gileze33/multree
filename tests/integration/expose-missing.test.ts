import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
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

// Regression: a producer value (or default) that contains a newline used to
// silently inject extra `KEY=VALUE` lines into the consumer's env file, hidden
// inside multree's managed block. Worse, a `\n` followed by the literal close
// sentinel forged an early block end and broke the idempotency contract of
// `rewire`. Wiring now refuses such values at the write boundary.
describe("wiring refuses env values that would smuggle a newline", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    // api is intentionally NOT in the group, so frontend resolves
                    // {api.port} against this booby-trapped default. A YAML
                    // multi-line string in the manifest is a realistic way for
                    // this to happen by accident.
                    defaults: { port: "5000\nEVIL_INJECTED=yes" },
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

    it("aborts create and leaves the consumer's env file untouched", () => {
        const r = runMultree(sb, ["create", "g", "--include", "frontend"]);
        assert.notEqual(r.status, 0, "create must fail when a wired value has a newline");
        assert.match(r.stderr, /newline|control/i);

        const envPath = join(sb.worktreePath("g", "frontend"), ".env");
        assert.ok(existsSync(envPath), "consumer's env file must still exist");
        const env = readFileSync(envPath, "utf-8");
        assert.match(env, /EXISTING=keep/, "user content must be preserved");
        assert.doesNotMatch(env, /EVIL_INJECTED/, "smuggled line must not appear");
        assert.doesNotMatch(env, /multree-managed/, "no managed block on failed write");
        assert.doesNotMatch(env, /API_URL=/, "no API_URL written when validation fails");
    });
});
