import { rmSync } from "fs";
import { expandPath, loadConfig, memberConfig } from "../config.ts";
import { removeWorktree } from "../git.ts";
import { normalizeHook, runMemberHook } from "../hooks.ts";
import { loadGroup, saveGroup } from "../state.ts";
import { releaseMemberVariables } from "../variables.ts";
import { wireGroup } from "../wiring.ts";

export async function removeCommand(groupName: string, memberName: string): Promise<void> {
    const { config, home, profile } = loadConfig();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    const member = group.members[memberName];
    if (!member) {
        throw new Error(`Member "${memberName}" is not in group "${groupName}"`);
    }

    const repoCfg = config.repos[memberName];
    const mCfg = memberConfig(config, memberName);

    const teardownHook = normalizeHook(mCfg?.hooks?.teardown);
    if (teardownHook && mCfg) {
        await runMemberHook({
            phase: "teardown",
            repoName: memberName,
            groupName,
            hook: teardownHook,
            // Apps have no source checkout, so a `cwd: repo` hook falls back to
            // the scratchpad.
            repoPath: repoCfg ? expandPath(repoCfg.path) : member.path,
            worktreePath: member.path,
            repoCfg: mCfg,
            config,
        });
    }

    if (repoCfg) {
        console.log(`[${memberName}] removing worktree`);
        removeWorktree(expandPath(repoCfg.path), member.path);
    } else if (config.apps?.[memberName]) {
        console.log(`[${memberName}] removing scratchpad`);
        rmSync(member.path, { recursive: true, force: true });
    }

    delete group.members[memberName];
    // Free the removed member's allocated variable values back into the pool.
    releaseMemberVariables(home, profile, groupName, memberName);

    // Re-wire remaining members: the removed member's exposes are gone from the
    // context so consumers fall back to defaults (e.g. api.port -> 5000), and the
    // group-root .mcp.json drops any servers the removed member owned.
    if (Object.keys(group.members).length > 0) {
        console.log("");
        wireGroup(config, group);
    }

    saveGroup(config, group);

    console.log(`\n✓ Removed "${memberName}" from group "${groupName}"`);
    if (Object.keys(group.members).length === 0) {
        console.log(`  Group is now empty. Use 'multree destroy ${groupName}' to clean up.`);
    }
}
