import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compareSemver } from "../../src/update-check.ts";

describe("compareSemver", () => {
    it("returns positive when a is newer than b", () => {
        assert.equal(compareSemver("1.2.3", "1.2.2"), 1);
        assert.equal(compareSemver("1.3.0", "1.2.9"), 1);
        assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
    });

    it("returns negative when a is older than b", () => {
        assert.equal(compareSemver("1.2.2", "1.2.3"), -1);
        assert.equal(compareSemver("0.1.1", "0.2.0"), -1);
    });

    it("returns zero on equality", () => {
        assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
        assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
        assert.equal(compareSemver("v1.2.3", "v1.2.3"), 0);
    });

    it("compares double-digit components numerically, not lexically", () => {
        assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
        assert.equal(compareSemver("1.9.9", "1.10.0"), -1);
        assert.equal(compareSemver("10.0.0", "2.0.0"), 1);
    });

    it("bails out (returns 0) on pre-release tags", () => {
        // We don't want to nag users on stable releases about a -rc on latest.
        assert.equal(compareSemver("1.2.4-rc.1", "1.2.3"), 0);
        assert.equal(compareSemver("1.2.3", "1.2.4-rc.1"), 0);
        assert.equal(compareSemver("1.2.3-beta", "1.2.3-alpha"), 0);
    });

    it("returns zero on malformed input", () => {
        assert.equal(compareSemver("not-a-version", "1.2.3"), 0);
        assert.equal(compareSemver("1.2", "1.2.3"), 0);
        assert.equal(compareSemver("1.2.3.4", "1.2.3"), 0);
        assert.equal(compareSemver("", "1.2.3"), 0);
        assert.equal(compareSemver("1.x.0", "1.2.0"), 0);
        assert.equal(compareSemver("1.-1.0", "1.0.0"), 0);
    });
});

describe("update-check cache integration", () => {
    let dir: string;
    const originalCacheDir = process.env.MULTREE_CACHE_DIR;
    const originalForce = process.env.MULTREE_FORCE_UPDATE_CHECK;
    const originalCI = process.env.CI;
    const originalDisable = process.env.MULTREE_NO_UPDATE_CHECK;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-update-check-"));
        process.env.MULTREE_CACHE_DIR = dir;
        // Force the check on for these unit tests — they don't spawn a child
        // process, they just exercise the notify path with a piped stderr.
        process.env.MULTREE_FORCE_UPDATE_CHECK = "1";
        delete process.env.CI;
        delete process.env.MULTREE_NO_UPDATE_CHECK;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        restore("MULTREE_CACHE_DIR", originalCacheDir);
        restore("MULTREE_FORCE_UPDATE_CHECK", originalForce);
        restore("CI", originalCI);
        restore("MULTREE_NO_UPDATE_CHECK", originalDisable);
    });

    it("notifyIfNewer writes to stderr when cache says a newer version exists", async () => {
        writeFileSync(
            join(dir, "version-check.json"),
            JSON.stringify({ latest: "9.9.9", checked_at: new Date().toISOString() }),
        );
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.match(captured, /new version available: 0\.1\.1 → 9\.9\.9/);
        assert.match(captured, /npm i -g multree-cli@latest/);
    });

    it("notifyIfNewer is silent when installed is at or above cached latest", async () => {
        writeFileSync(
            join(dir, "version-check.json"),
            JSON.stringify({ latest: "0.1.1", checked_at: new Date().toISOString() }),
        );
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.equal(captured, "");
    });

    it("notifyIfNewer is silent when no cache exists", async () => {
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.equal(captured, "");
    });

    it("notifyIfNewer suppresses output when MULTREE_NO_UPDATE_CHECK=1", async () => {
        writeFileSync(
            join(dir, "version-check.json"),
            JSON.stringify({ latest: "9.9.9", checked_at: new Date().toISOString() }),
        );
        delete process.env.MULTREE_FORCE_UPDATE_CHECK;
        process.env.MULTREE_NO_UPDATE_CHECK = "1";
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.equal(captured, "");
    });

    it("notifyIfNewer suppresses output when CI=true", async () => {
        writeFileSync(
            join(dir, "version-check.json"),
            JSON.stringify({ latest: "9.9.9", checked_at: new Date().toISOString() }),
        );
        delete process.env.MULTREE_FORCE_UPDATE_CHECK;
        process.env.CI = "true";
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.equal(captured, "");
    });

    it("MULTREE_FORCE_UPDATE_CHECK overrides every other suppression source", async () => {
        writeFileSync(
            join(dir, "version-check.json"),
            JSON.stringify({ latest: "9.9.9", checked_at: new Date().toISOString() }),
        );
        process.env.MULTREE_FORCE_UPDATE_CHECK = "1";
        process.env.CI = "true";
        process.env.MULTREE_NO_UPDATE_CHECK = "1";
        const { notifyIfNewer } = await import("../../src/update-check.ts");
        const captured = await captureStderr(() => notifyIfNewer("0.1.1"));
        assert.match(captured, /new version available/);
    });

    it("notifyIfNewer ignores corrupt cache files", async () => {
        writeFileSync(join(dir, "version-check.json"), "{ not valid json");
        const captured = await captureStderr(async () => {
            const { notifyIfNewer } = await import("../../src/update-check.ts");
            notifyIfNewer("0.1.1");
        });
        assert.equal(captured, "");
    });
});

async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
    const orig = process.stderr.write.bind(process.stderr);
    let buf = "";
    // Stub write to capture stderr without leaking to the test runner.
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        return true;
    }) as typeof process.stderr.write;
    try {
        await fn();
    } finally {
        process.stderr.write = orig;
    }
    return buf;
}

function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
