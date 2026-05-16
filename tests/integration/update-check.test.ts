import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
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

    describe("against a stubbed registry", () => {
        let server: Server;
        let url: string;
        let response: { status: number; body: string };
        let hits: number;

        beforeEach(async () => {
            response = { status: 200, body: JSON.stringify({ version: "9.9.9" }) };
            hits = 0;
            server = createServer((_req, res) => {
                hits += 1;
                res.statusCode = response.status;
                res.setHeader("content-type", "application/json");
                res.end(response.body);
            });
            await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
            const addr = server.address() as AddressInfo;
            url = `http://127.0.0.1:${addr.port}/multree-cli/latest`;
        });
        afterEach(async () => {
            await new Promise<void>(r => server.close(() => r()));
        });

        function cachePath(): string {
            return join(cacheDir, "version-check.json");
        }
        function readCacheFile(): { latest: string; checked_at: string } | null {
            if (!existsSync(cachePath())) {
                return null;
            }
            return JSON.parse(readFileSync(cachePath(), "utf-8"));
        }

        it("__update-check writes the cache after a successful fetch", async () => {
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const result = await spawnCliAsync(env, ["__update-check"]);
            assert.equal(result.status, 0);
            assert.equal(hits, 1, "registry should have been hit exactly once");
            const cache = readCacheFile();
            assert.ok(cache, "cache file should exist");
            assert.equal(cache.latest, "9.9.9");
            // checked_at is a valid ISO date within the last few seconds.
            const age = Date.now() - new Date(cache.checked_at).getTime();
            assert.ok(age >= 0 && age < 10_000, `unexpected checked_at age: ${age}ms`);
        });

        it("__update-check does NOT write the cache on a 5xx", async () => {
            response = { status: 503, body: "service unavailable" };
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const result = await spawnCliAsync(env, ["__update-check"]);
            assert.equal(result.status, 0);
            assert.equal(hits, 1);
            assert.equal(readCacheFile(), null, "cache must not be written on non-2xx");
        });

        it("__update-check ignores a 200 with a missing version field", async () => {
            response = { status: 200, body: JSON.stringify({ name: "multree-cli" }) };
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const result = await spawnCliAsync(env, ["__update-check"]);
            assert.equal(result.status, 0);
            assert.equal(readCacheFile(), null);
        });

        it("__update-check refuses a non-semver version (taint barrier)", async () => {
            // ANSI escape + path traversal + control bytes — none of which
            // must ever reach the cache file or the user's terminal.
            response = {
                status: 200,
                body: JSON.stringify({ version: "1.2.3[31m../../etc/passwd" }),
            };
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const result = await spawnCliAsync(env, ["__update-check"]);
            assert.equal(result.status, 0);
            assert.equal(readCacheFile(), null, "non-semver values must be refused at the boundary");
        });

        it("kick → background fetch → notify on the next run", async () => {
            // First run: cache is empty, so kickBackgroundCheck spawns the
            // detached child. The parent doesn't wait for it.
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const first = spawnCli(env, ["--version"]);
            assert.equal(first.status, 0);
            // Nothing to notify yet — cache was empty when we read it.
            assert.doesNotMatch(first.stderr, /new version available/);

            // Wait for the detached child to finish writing the cache.
            await waitFor(() => readCacheFile() !== null, 5000);
            assert.equal(hits, 1, "background child should have hit the registry");
            const cache = readCacheFile()!;
            assert.equal(cache.latest, "9.9.9");

            // Second run: cache is now populated; we should see the notice.
            // Cache is fresh, so kick is a no-op (no additional registry hit).
            const second = spawnCli(env, ["--version"]);
            assert.equal(second.status, 0);
            assert.match(second.stderr, /new version available: \d+\.\d+\.\d+ → 9\.9\.9/);
            assert.equal(hits, 1, "fresh cache means no second registry hit");
        });

        it("kick is skipped while the cache is still fresh", async () => {
            // Pre-seed a fresh cache. The CLI run should NOT spawn a child.
            seedCache("9.9.9");
            const env = envWith({ MULTREE_REGISTRY_URL: url });
            const result = spawnCli(env, ["--version"]);
            assert.equal(result.status, 0);
            // Give any (incorrectly) spawned child time to phone home.
            await sleep(300);
            assert.equal(hits, 0, "fresh cache must not trigger a background fetch");
        });

        it("MULTREE_NO_UPDATE_CHECK=1 suppresses both notify AND the background kick", async () => {
            // Empty cache + suppression → no notice AND no registry hit.
            const env = envWith({
                MULTREE_REGISTRY_URL: url,
                MULTREE_FORCE_UPDATE_CHECK: "",
                MULTREE_NO_UPDATE_CHECK: "1",
            });
            const result = spawnCli(env, ["--version"]);
            assert.equal(result.status, 0);
            assert.doesNotMatch(result.stderr, /new version available/);
            await sleep(300);
            assert.equal(hits, 0);
            assert.equal(readCacheFile(), null);
        });
    });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function spawnCli(env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(BIN, args, { env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Async variant for tests that need the parent's event loop to keep running
// while the child is alive (e.g. when the parent hosts an HTTP server the
// child is talking to). spawnSync would deadlock that case.
function spawnCliAsync(
    env: NodeJS.ProcessEnv,
    args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", d => {
            stdout += d.toString();
        });
        child.stderr.on("data", d => {
            stderr += d.toString();
        });
        child.on("close", code => resolve({ status: code ?? -1, stdout, stderr }));
    });
}
