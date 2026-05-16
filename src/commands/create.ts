import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { primeArtifacts } from "../artifacts.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, fetchRepo } from "../git.ts";
import { normalizeHook, runHook } from "../hooks.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import type { GroupState } from "../types.ts";
import { readExposes, wireGroup } from "../wiring.ts";

interface CreateArgs {
    name: string;
    include: string[];
    branch?: string;
}

export async function createCommand(args: CreateArgs): Promise<void> {
    const { config } = loadConfig();

    if (loadGroup(config, args.name)) {
        throw new Error(`Group "${args.name}" already exists. Destroy it first, or use a different name.`);
    }

    for (const repo of args.include) {
        if (!config.repos[repo]) {
            throw new Error(
                `Unknown repo "${repo}". Available: ${Object.keys(config.repos).join(", ")}`,
            );
        }
    }

    const branch = args.branch ?? `multree/${args.name}`;
    const dir = groupDir(config, args.name);
    if (existsSync(dir)) {
        throw new Error(`Group directory already exists: ${dir}`);
    }
    mkdirSync(dir, { recursive: true });

    const group: GroupState = {
        name: args.name,
        branch,
        created_at: new Date().toISOString(),
        members: {},
    };

    // Persist the empty group up front. Each member is then recorded
    // immediately after its worktree exists on disk, BEFORE hooks run --
    // so destroy can always find what to clean up even if a hook throws.
    saveGroup(config, group);

    for (const repoName of args.include) {
        const repoCfg = config.repos[repoName];
        const repoPath = expandPath(repoCfg.path);
        const worktreePath = join(dir, basename(repoPath));

        console.log(`\n[${repoName}] git fetch`);
        fetchRepo(repoPath);

        console.log(`[${repoName}] creating worktree at ${worktreePath}`);
        addWorktree(repoPath, worktreePath, branch, resolveBranchBase(repoCfg));

        group.members[repoName] = { repo: repoName, path: worktreePath, exposes: {} };
        saveGroup(config, group);

        if (repoCfg.prime_artifacts && repoCfg.prime_artifacts.length > 0) {
            console.log(`[${repoName}] priming artifacts`);
            primeArtifacts(repoPath, worktreePath, repoCfg.prime_artifacts);
        }

        const installHook = normalizeHook(repoCfg.hooks?.install);
        if (installHook) {
            console.log(`[${repoName}] install hook`);
            const cwd = installHook.cwd === "repo" ? repoPath : worktreePath;
            runHook(installHook.command, cwd);
        }

        const setupHook = normalizeHook(repoCfg.hooks?.setup);
        if (setupHook) {
            console.log(`[${repoName}] setup hook`);
            const cwd = setupHook.cwd === "repo" ? repoPath : worktreePath;
            runHook(setupHook.command, cwd);
        }

        // Capture exposes after this member's setup completed successfully.
        group.members[repoName].exposes = readExposes(worktreePath, repoCfg.exposes);
        saveGroup(config, group);
    }

    console.log("");
    wireGroup(config, group);
    saveGroup(config, group);

    console.log(`\n✓ Group "${args.name}" created on branch "${branch}"`);
    console.log(`  Group dir: ${dir}`);
    for (const [repoName, member] of Object.entries(group.members)) {
        console.log(`  ${repoName}: ${member.path}`);
        for (const [k, v] of Object.entries(member.exposes)) {
            console.log(`    exposed ${k}=${v}`);
        }
    }
}
