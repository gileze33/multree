import { existsSync } from "fs";
import { basename, join } from "path";
import { primeArtifacts } from "../artifacts.ts";
import { executeMainCheckoutRelease, planMainCheckoutRelease } from "../branch.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, fetchRepo } from "../git.ts";
import { normalizeHook, runMemberHook } from "../hooks.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import { wireGroup } from "../wiring.ts";

interface AddOptions {
    verbose?: boolean;
}

export async function addCommand(
    groupName: string,
    repoName: string,
    opts: AddOptions = {},
): Promise<void> {
    const { config } = loadConfig();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    const repoCfg = config.repos[repoName];
    if (!repoCfg) {
        throw new Error(
            `Unknown repo "${repoName}". Available: ${Object.keys(config.repos).join(", ")}`,
        );
    }
    if (group.members[repoName]) {
        throw new Error(`Repo "${repoName}" is already in group "${groupName}"`);
    }

    const repoPath = expandPath(repoCfg.path);
    const worktreePath = join(groupDir(config, groupName), basename(repoPath));
    if (existsSync(worktreePath)) {
        throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    console.log(`[${repoName}] git fetch`);
    fetchRepo(repoPath);

    const repoBranch = group.branch;

    const release = planMainCheckoutRelease(config, repoCfg, repoName, repoPath, repoBranch);
    if (release.error) {
        throw new Error(release.error);
    }
    if (release.plan) {
        executeMainCheckoutRelease(repoName, repoPath, repoBranch, release.plan);
    }

    console.log(`[${repoName}] creating worktree at ${worktreePath} (branch: ${repoBranch})`);
    addWorktree(repoPath, worktreePath, repoBranch, resolveBranchBase(repoCfg));

    group.members[repoName] = {
        repo: repoName,
        path: worktreePath,
        branch: repoBranch,
        exposes: {},
    };
    saveGroup(config, group);

    if (repoCfg.prime_artifacts && repoCfg.prime_artifacts.length > 0) {
        console.log(`[${repoName}] priming artifacts`);
        primeArtifacts(repoPath, worktreePath, repoCfg.prime_artifacts);
    }

    for (const phase of ["install", "setup"] as const) {
        const hook = normalizeHook(repoCfg.hooks?.[phase]);
        if (!hook) {
            continue;
        }
        await runMemberHook({
            phase,
            repoName,
            hook,
            repoPath,
            worktreePath,
            repoCfg,
            config,
            verbose: opts.verbose,
        });
    }

    // Re-wire across the whole group: the new repo's exposes (if any) may
    // affect existing members' consumes, and the new repo's consumes need
    // to be applied against the current context.
    console.log("");
    wireGroup(config, group);

    saveGroup(config, group);

    console.log(`\n✓ Added "${repoName}" to group "${groupName}"`);
    console.log(`  ${repoName}: ${worktreePath}`);
}
