import { existsSync } from "fs";
import { basename, join } from "path";
import { executeMainCheckoutRelease, planMainCheckoutRelease } from "../branch.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, fetchRepo } from "../git.ts";
import { runMemberPhase } from "../phases.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import type { PhaseName } from "../types.ts";
import { wireGroup } from "../wiring.ts";

interface AddOptions {
    verbose?: boolean;
}

const PHASES: PhaseName[] = ["prime", "install", "setup"];

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

    const member = {
        repo: repoName,
        path: worktreePath,
        branch: repoBranch,
        exposes: {},
    };
    group.members[repoName] = member;
    saveGroup(config, group);

    const ctx = { repoName, repoCfg, repoPath, worktreePath };
    for (const phase of PHASES) {
        await runMemberPhase(config, ctx, member, phase, { verbose: opts.verbose });
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
