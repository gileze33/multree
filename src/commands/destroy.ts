import { expandPath, loadConfig } from "../config.ts";
import { removeWorktree } from "../git.ts";
import { normalizeHook, runHook } from "../hooks.ts";
import { deleteGroupDir, loadGroup } from "../state.ts";

export function destroyCommand(name: string): void {
    const { config } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) throw new Error(`Group not found: ${name}`);

    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg) {
            console.warn(`[${repoName}] no longer in config; skipping hooks`);
            continue;
        }

        const teardownHook = normalizeHook(repoCfg.hooks?.teardown);
        if (teardownHook) {
            try {
                console.log(`[${repoName}] teardown hook`);
                const cwd = teardownHook.cwd === "repo" ? expandPath(repoCfg.path) : member.path;
                runHook(teardownHook.command, cwd);
            } catch (err) {
                console.error(`[${repoName}] teardown failed: ${err instanceof Error ? err.message : err}`);
            }
        }

        console.log(`[${repoName}] removing worktree`);
        removeWorktree(expandPath(repoCfg.path), member.path);
    }

    deleteGroupDir(config, name);
    console.log(`\n✓ Group "${name}" destroyed`);
    console.log(`  (branch "${group.branch}" left in place; delete manually if no longer needed)`);
}
