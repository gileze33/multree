import { closeWorkspace, cmuxReachable } from "../cmux.ts";
import { expandPath, loadConfig, memberConfig } from "../config.ts";
import { removeWorktree } from "../git.ts";
import { normalizeHook, runMemberHook } from "../hooks.ts";
import { deleteGroupDir, loadGroup } from "../state.ts";
import { releaseGroupVariables } from "../variables.ts";

export async function destroyCommand(name: string): Promise<void> {
    const { config, home, profile } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) {
        throw new Error(`Group not found: ${name}`);
    }

    // Capture the cmux workspace id up front; closing the workspace is deferred
    // to the very end (see below), after which group state no longer exists.
    const cmuxWorkspaceId = group.cmux?.workspace_id;

    for (const [memberName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[memberName];
        const mCfg = memberConfig(config, memberName);
        if (!mCfg) {
            console.warn(`[${memberName}] no longer in config; skipping hooks`);
            continue;
        }

        // Only repos have teardown hooks; apps are just scratchpad dirs removed below.
        const teardownHook = repoCfg ? normalizeHook(repoCfg.hooks?.teardown) : undefined;
        if (teardownHook && repoCfg) {
            await runMemberHook({
                phase: "teardown",
                repoName: memberName,
                groupName: name,
                hook: teardownHook,
                repoPath: expandPath(repoCfg.path),
                worktreePath: member.path,
                repoCfg,
                config,
            });
        }

        if (repoCfg) {
            console.log(`[${memberName}] removing worktree`);
            removeWorktree(expandPath(repoCfg.path), member.path);
        }
        // Apps have only a scratchpad dir, deleted wholesale by deleteGroupDir below.
    }

    deleteGroupDir(config, name);
    // Free every value the group held so the numbers return to the pool.
    releaseGroupVariables(home, profile, name);
    console.log(`\n✓ Group "${name}" destroyed`);
    console.log(`  (branch "${group.branch}" left in place; delete manually if no longer needed)`);

    // Close the cmux workspace last. Destroy is often run from a shell inside
    // the group's own workspace, and closing it kills that shell (and this
    // process), so everything that must complete (teardown hooks that purge
    // DBs, worktree removal, state and variable cleanup) has to run first.
    // Call closeWorkspace directly rather than teardownCmuxWorkspace: the group
    // dir is already gone, and teardown's trailing saveGroup would recreate it.
    if (cmuxWorkspaceId && cmuxReachable()) {
        console.log("[cmux] closing workspace");
        closeWorkspace(cmuxWorkspaceId);
    }
}
