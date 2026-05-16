import { execSync } from "child_process";
import type { HookCmd, HookSpec } from "./types.ts";

export function normalizeHook(spec: HookSpec | undefined): HookCmd | undefined {
    if (spec === undefined) return undefined;
    if (typeof spec === "string") return { command: spec, cwd: "worktree" };
    return spec;
}

export function runHook(command: string, cwd: string): void {
    console.log(`  $ (${cwd}) ${command}`);
    execSync(command, { cwd, stdio: "inherit", env: process.env, shell: "/bin/bash" });
}
