import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "multree");

describe("update notify", () => {
    let sb: Sandbox;
    let cacheDir: string;

    beforeEach(() => {
        sb = createSandbox({
            repos: [{ key: "api", install: "true" }],
        });
        cacheDir = join(sb.root, "cache");
        mkdirSync(cacheDir, { recursive: true });
    });
    afterEach(() => {
        sb.cleanup();
    });

    function envWith(extras: Record<string, string>): NodeJS.ProcessEnv {
        // Drop the parent's CI env so tests on CI don't suppress the check.
        const { CI: _ignored, ...rest } = sb.env;
        void _ignored;
        return {
            ...rest,
            MULTREE_CACHE_DIR: cacheDir,
            MULTREE_FORCE_UPDATE_CHECK: "1",
            ...extras,
        };
    }

    function seedCache(latest: string, ageMs = 0): void {
        const checked_at = new Date(Date.now() - ageMs).toISOString();
        writeFileSync(
            join(cacheDir, "version-check.json"),
            JSON.stringify({ latest, checked_at }),
        );
    }

    it("prints a one-line stderr notice when a newer version is cached", () => {
        // Recent cache: kickBackgroundCheck is a no-op so we don't fire a real
        // network request from the test process.
        seedCache("9.9.9");
        const env = envWith({});
        const result = spawnCli(env, ["--version"]);
        assert.equal(result.status, 0);
        assert.match(result.stderr, /\[multree\] new version available/);
        assert.match(result.stderr, /→ 9\.9\.9/);
        assert.match(result.stderr, /npm i -g multree-cli@latest/);
        // Version output itself stays on stdout, unpolluted.
        assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
    });

    it("is silent when the cache says we're already up to date", () => {
        seedCache("0.0.1");
        const env = envWith({});
        const result = spawnCli(env, ["--version"]);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stderr, /new version available/);
    });

    it("is silent when MULTREE_NO_UPDATE_CHECK=1 even with a newer cache", () => {
        seedCache("9.9.9");
        const env = envWith({ MULTREE_NO_UPDATE_CHECK: "1", MULTREE_FORCE_UPDATE_CHECK: "" });
        const result = spawnCli(env, ["--version"]);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stderr, /new version available/);
    });

    it("is silent when CI=true and the test override is not set", () => {
        seedCache("9.9.9");
        const env = envWith({ CI: "true", MULTREE_FORCE_UPDATE_CHECK: "" });
        const result = spawnCli(env, ["--version"]);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stderr, /new version available/);
    });

    it("the hidden __update-check subcommand produces no user-visible output", () => {
        // We can't reach npm.org from tests, so the fetch will fail or time
        // out — but the subcommand must never throw or print noise.
        seedCache("0.0.1");
        const env = envWith({ MULTREE_NO_UPDATE_CHECK: "1" }); // suppress nested kick
        const result = spawnCli(env, ["__update-check"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
    });
});

function spawnCli(env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(BIN, args, { env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
