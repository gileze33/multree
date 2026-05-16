import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "./sandbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BIN = resolve(REPO_ROOT, "bin", "multree");

export interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

export function runMultree(sb: Sandbox, args: string[]): CliResult {
    const result = spawnSync(BIN, args, {
        env: sb.env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        status: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}
