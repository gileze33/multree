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
// inside multree's managed block. Wiring now strips the offending characters
// at the first newline and warns loudly, so the user keeps making progress
// (typical cause: an accidental multi-line YAML default) while the smuggled
// payload is never written to disk.
describe("wiring self-heals env values that contain embedded newlines", () => {
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

    it("truncates at the first newline, warns, and writes only the sanitized value", () => {
        const r = runMultree(sb, ["create", "g", "--include", "frontend"]);
        assert.equal(r.status, 0, `create must self-heal; got: ${r.stderr}`);
        // Warning is on stderr so the user actually sees it on a noisy run.
        assert.match(
            r.stderr,
            /API_URL.*(newline|stripped)/i,
            `expected a warning naming API_URL; got stderr: ${r.stderr}`,
        );

        const envPath = join(sb.worktreePath("g", "frontend"), ".env");
        assert.ok(existsSync(envPath), "consumer's env file must exist");
        const env = readFileSync(envPath, "utf-8");

        assert.match(env, /EXISTING=keep/, "user content must be preserved");
        assert.match(env, /multree-managed: g/, "managed block must be written");
        assert.match(
            env,
            /^API_URL=http:\/\/localhost:5000$/m,
            "API_URL must be present with the sanitized value (truncated at \\n)",
        );
        assert.doesNotMatch(env, /EVIL_INJECTED/, "smuggled line must never reach disk");
    });
});
