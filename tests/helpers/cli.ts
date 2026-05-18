import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BIN = resolve(REPO_ROOT, "bin", "multree");

export interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

// Anything with an `env` field works — both `Sandbox` and `MultiProfileSandbox`
// (and bare `{ env }` objects used by the env-var resolution tests).
export interface CliRunner {
    env: NodeJS.ProcessEnv;
}

export function runMultree(sb: CliRunner, args: string[]): CliResult {
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
