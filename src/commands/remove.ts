import { expandPath, loadConfig } from "../config.ts";
import { removeWorktree } from "../git.ts";
import { normalizeHook, runHook } from "../hooks.ts";
import { loadGroup, saveGroup } from "../state.ts";
import { wireGroup } from "../wiring.ts";

export async function removeCommand(groupName: string, repoName: string): Promise<void> {
    const { config } = loadConfig();
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
        try {
            console.log(`[${repoName}] teardown hook`);
            const cwd = teardownHook.cwd === "repo" ? expandPath(repoCfg.path) : member.path;
            await runHook(teardownHook.command, cwd);
        } catch (err) {
            console.error(`[${repoName}] teardown failed: ${err instanceof Error ? err.message : err}`);
        }
    }

    if (repoCfg) {
        console.log(`[${repoName}] removing worktree`);
        removeWorktree(expandPath(repoCfg.path), member.path);
    }

    delete group.members[repoName];

    // Re-wire remaining members: removed repo's exposes are gone from the
    // context so frontends fall back to defaults (e.g. api.port -> 5000).
    if (Object.keys(group.members).length > 0) {
        console.log("");
        wireGroup(config, group);
    }

    saveGroup(config, group);

    console.log(`\n✓ Removed "${repoName}" from group "${groupName}"`);
    if (Object.keys(group.members).length === 0) {
        console.log(`  Group is now empty. Use 'multree destroy ${groupName}' to clean up.`);
    }
}
