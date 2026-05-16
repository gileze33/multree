// Lightweight "notify-only" CLI version check. The current run never blocks
// on the network: a detached child process refreshes a small cache file every
// few hours, and the next run reads that cache to print a one-line notice if
// the installed version is behind.
//
// Source of truth: the npm registry (`registry.npmjs.org/multree-cli/latest`).
//
// Suppression: `CI`, no stderr TTY, or `MULTREE_NO_UPDATE_CHECK=1`. Tests can
// force the check on via `MULTREE_FORCE_UPDATE_CHECK=1`, and override the
// cache directory via `MULTREE_CACHE_DIR`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "multree-cli";
const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const CACHE_FILENAME = "version-check.json";

function registryUrl(): string {
    // Test-only override so the integration suite can point the fetch at a
    // local HTTP server. Production paths always hit the npm registry.
    return process.env.MULTREE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

interface VersionCache {
    latest: string;
    checked_at: string;
}

function cacheDir(): string {
    if (process.env.MULTREE_CACHE_DIR) {
        return process.env.MULTREE_CACHE_DIR;
    }
    const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
    return join(base, "multree");
}

function cacheFile(): string {
    return join(cacheDir(), CACHE_FILENAME);
}

function readCache(): VersionCache | null {
    try {
        const data = readFileSync(cacheFile(), "utf-8");
        const parsed = JSON.parse(data) as Partial<VersionCache>;
        if (typeof parsed.latest !== "string" || typeof parsed.checked_at !== "string") {
            return null;
        }
        return { latest: parsed.latest, checked_at: parsed.checked_at };
    } catch {
        return null;
    }
}

function writeCache(cache: VersionCache): void {
    try {
        mkdirSync(cacheDir(), { recursive: true });
        writeFileSync(cacheFile(), JSON.stringify(cache, null, 2));
    } catch {
        // Best effort; never let cache failures break the CLI.
    }
}

function envTruthy(name: string): boolean {
    const v = process.env[name];
    if (v === undefined) {
        return false;
    }
    return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function checkSuppressed(): boolean {
    if (envTruthy("MULTREE_FORCE_UPDATE_CHECK")) {
        return false;
    }
    if (envTruthy("MULTREE_NO_UPDATE_CHECK")) {
        return true;
    }
    if (envTruthy("CI")) {
        return true;
    }
    if (!process.stderr.isTTY) {
        return true;
    }
    return false;
}

// Compare two semver-ish strings. Returns 1 if a>b, -1 if a<b, 0 otherwise.
// Pre-release tags cause the comparison to bail out (returns 0): we don't want
// to nag users on stable releases about a `-rc` published to latest, and we
// don't want pre-release installs to nag about stable downgrades.
export function compareSemver(a: string, b: string): number {
    const pa = a.replace(/^v/, "");
    const pb = b.replace(/^v/, "");
    if (pa.includes("-") || pb.includes("-")) {
        return 0;
    }
    const sa = pa.split(".");
    const sb = pb.split(".");
    if (sa.length !== 3 || sb.length !== 3) {
        return 0;
    }
    for (let i = 0; i < 3; i++) {
        const av = Number(sa[i]);
        const bv = Number(sb[i]);
        if (!Number.isInteger(av) || !Number.isInteger(bv) || av < 0 || bv < 0) {
            return 0;
        }
        if (av > bv) {
            return 1;
        }
        if (av < bv) {
            return -1;
        }
    }
    return 0;
}

// Synchronous: read the cache and print a one-line notice if a newer
// version is available. Never throws.
export function notifyIfNewer(installed: string): void {
    if (checkSuppressed()) {
        return;
    }
    const cache = readCache();
    if (!cache) {
        return;
    }
    if (compareSemver(cache.latest, installed) <= 0) {
        return;
    }
    const useColor = process.stderr.isTTY && !envTruthy("NO_COLOR");
    const tag = useColor ? "[33m[multree][0m" : "[multree]";
    process.stderr.write(
        `${tag} new version available: ${installed} → ${cache.latest} ` +
            `(run: npm i -g ${PACKAGE_NAME}@latest)\n`,
    );
}

// Pick the right command + args to relaunch the CLI for the hidden
// `__update-check` subcommand. Returns null in environments where we can't
// figure that out (we just skip the kick rather than guessing).
function checkerEntry(): { cmd: string; args: string[] } | null {
    try {
        const here = fileURLToPath(import.meta.url);
        if (here.endsWith(".mjs") || here.endsWith(".js")) {
            // Published build: this module IS the CLI entry. Spawn node on it.
            return { cmd: process.execPath, args: [here, "__update-check"] };
        }
        if (here.endsWith(".ts")) {
            // Dev: re-launch via the bash shim, which knows how to find tsx.
            const bin = join(dirname(here), "..", "bin", "multree");
            if (existsSync(bin)) {
                return { cmd: bin, args: ["__update-check"] };
            }
        }
    } catch {
        // fall through
    }
    return null;
}

// Spawn a detached child to refresh the cache file. The current process
// returns immediately and never waits on the child.
export function kickBackgroundCheck(): void {
    if (checkSuppressed()) {
        return;
    }
    const cache = readCache();
    if (cache) {
        const age = Date.now() - new Date(cache.checked_at).getTime();
        if (Number.isFinite(age) && age >= 0 && age < CHECK_INTERVAL_MS) {
            return;
        }
    }
    const entry = checkerEntry();
    if (!entry) {
        return;
    }
    try {
        const child = spawn(entry.cmd, entry.args, {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, MULTREE_RUNNING_CHECK: "1" },
        });
        child.on("error", () => {
            // Swallow spawn failures; we'll try again next run.
        });
        child.unref();
    } catch {
        // ignore
    }
}

// Entry point for the hidden `__update-check` subcommand. Fetches the npm
// registry with a short timeout and updates the cache. Never throws.
export async function runUpdateCheck(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(registryUrl(), {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!res.ok) {
            return;
        }
        const data = (await res.json()) as { version?: unknown };
        if (typeof data.version !== "string" || data.version.length === 0) {
            return;
        }
        writeCache({ latest: data.version, checked_at: new Date().toISOString() });
    } catch {
        // Offline, registry down, abort — all benign. Try again next run.
    } finally {
        clearTimeout(timer);
    }
}
