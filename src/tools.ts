import { loadConfig } from "./config.ts";
import { runForeground } from "./exec.ts";
import { groupDir, loadGroup } from "./state.ts";
import type { GroupState, MultreeConfig, ToolConfig } from "./types.ts";

const ROOT_SENTINEL = "$root";

function resolveCwd(
    config: MultreeConfig,
    group: GroupState,
    openIn: string | string[] | undefined,
): string {
    const chain = openIn === undefined ? [ROOT_SENTINEL] : Array.isArray(openIn) ? openIn : [openIn];
    for (const item of chain) {
        if (item === ROOT_SENTINEL) {
            return groupDir(config, group.name);
        }
        const member = group.members[item];
        if (member) {
            return member.path;
        }
    }
    return groupDir(config, group.name);
}

export function toolCommand(toolName: string, groupName: string): void {
    const { config } = loadConfig();
    const tool: ToolConfig | undefined = config.tools?.[toolName];
    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    const cwd = resolveCwd(config, group, tool.open_in);
    console.log(`${toolName}: ${cwd}`);
    runForeground(tool.command, cwd);
}
