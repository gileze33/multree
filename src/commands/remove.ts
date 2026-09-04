import { expandPath, loadConfigForInspection } from "../config.ts";
import { removeWorktree } from "../git.ts";
import { normalizeHook, runMemberHook } from "../hooks.ts";
import { loadGroup, saveGroup } from "../state.ts";
import { releaseMemberVariables } from "../variables.ts";
import { wireGroup } from "../wiring.ts";

export async function removeCommand(groupName: string, repoName: string): Promise<void> {
    const { config, home, profile, primeArtifactsValid } = loadConfigForInspection();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    const member = group.members[repoName];
    if (!member) {
        throw new Error(`Repo "${repoName}" is not in group "${groupName}"`);
    }

    const repoCfg = config.repos[repoName];

    const teardownHook = normalizeHook(repoCfg?.hooks?.teardown);
    if (teardownHook && repoCfg) {
        await runMemberHook({
            phase: "teardown",
            repoName,
            groupName,
            hook: teardownHook,
            repoPath: expandPath(repoCfg.path),
            worktreePath: member.path,
            repoCfg,
            config,
        });
    }

    if (repoCfg) {
        console.log(`[${repoName}] removing worktree`);
        removeWorktree(expandPath(repoCfg.path), member.path);
    }

    delete group.members[repoName];
    // Free the removed repo's allocated variable values back into the pool.
    releaseMemberVariables(home, profile, groupName, repoName);

    // Persist the removal before anything optional runs, so a skipped re-wire
    // can never leave the removed member behind in the state file.
    saveGroup(config, group);

    // Re-wire remaining members: removed repo's exposes are gone from the
    // context so frontends fall back to defaults (e.g. api.port -> 5000).
    //
    // Wiring WRITES into each member's env file, and a primed symlink makes
    // that write land in the repo's main checkout. Rejecting that pairing is
    // exactly what the collision guard does, so when the guard was tolerated
    // we must not write. The teardown above still stands.
    if (Object.keys(group.members).length > 0) {
        if (!primeArtifactsValid) {
            console.warn(
                `\n! Skipping re-wire: prime_artifacts is invalid, so the symlink ` +
                    `collision guard is not in force.\n` +
                    `  Fix the manifest, then run 'multree rewire ${groupName}'.`,
            );
        } else {
            console.log("");
            wireGroup(config, group);
            saveGroup(config, group);
        }
    }

    console.log(`\n✓ Removed "${repoName}" from group "${groupName}"`);
    if (Object.keys(group.members).length === 0) {
        console.log(`  Group is now empty. Use 'multree destroy ${groupName}' to clean up.`);
    }
}
