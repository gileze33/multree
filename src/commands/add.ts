import { existsSync } from "fs";
import { basename, join } from "path";
import { primeArtifacts } from "../artifacts.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, fetchRepo } from "../git.ts";
import { normalizeHook, runHook } from "../hooks.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import { wireGroup } from "../wiring.ts";

export async function addCommand(groupName: string, repoName: string): Promise<void> {
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

    console.log(`[${repoName}] creating worktree at ${worktreePath}`);
    addWorktree(repoPath, worktreePath, group.branch, resolveBranchBase(repoCfg));

    // Persist the new member before hooks run so destroy can recover the
    // worktree even if a hook throws.
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

    // Re-wire across the whole group: the new repo's exposes (if any) may
    // affect existing members' consumes, and the new repo's consumes need
    // to be applied against the current context.
    console.log("");
    wireGroup(config, group);

    saveGroup(config, group);

    console.log(`\n✓ Added "${repoName}" to group "${groupName}"`);
    console.log(`  ${repoName}: ${worktreePath}`);
}
