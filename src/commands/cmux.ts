import {
    buildLayout,
    ensureCmuxWorkspace,
    formatOpenResult,
    teardownCmuxWorkspace,
    workspaceExists,
} from "../cmux.ts";
import { loadConfig } from "../config.ts";
import { loadGroup } from "../state.ts";

const USAGE =
    "usage: multree cmux <up|down|status> <group> [--print] [--focus] [--group <name|current>] [--no-group]";

// Resolve the cmux sidebar-group override from flags: --no-group -> "none", a
// --group <value> passes through, absent leaves it to config (current group).
function groupOverride(flags: Record<string, string | true>): string | undefined {
    if (flags["no-group"] === true) {
        return "none";
    }
    if (flags.group === true) {
        throw new Error("--group requires a value (a group name, or 'current')");
    }
    return typeof flags.group === "string" ? flags.group : undefined;
}

// `multree cmux up|down|status <group>` — open, close, or report the cmux
// workspace for a group on demand (the attach-later workflow, separate from
// `create`'s inline open).
export function cmuxCommand(args: string[], flags: Record<string, string | true>): void {
    const sub = args[0];
    if (sub !== "up" && sub !== "down" && sub !== "status") {
        throw new Error(USAGE);
    }
    const groupName = args[1];
    if (!groupName) {
        throw new Error(`cmux ${sub} requires a group name`);
    }

    const { config } = loadConfig();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    if (sub === "up") {
        // `--print` dumps the layout JSON without touching cmux — handy for
        // debugging the generated arrangement.
        if (flags.print === true) {
            console.log(JSON.stringify(buildLayout(config, group).layout, null, 2));
            return;
        }
        const result = ensureCmuxWorkspace(config, group, flags.focus === true, groupOverride(flags));
        const { text, warn } = formatOpenResult(result, groupName);
        if (warn) {
            console.warn(text);
        } else {
            console.log(`✓ ${text}`);
        }
        return;
    }

    if (sub === "down") {
        if (teardownCmuxWorkspace(config, group)) {
            console.log(`✓ cmux workspace closed for "${groupName}"`);
        } else {
            console.log(`No cmux workspace recorded for "${groupName}"`);
        }
        return;
    }

    // status
    const id = group.cmux?.workspace_id;
    const state = id ? (workspaceExists(id) ? `open (${id})` : `recorded but not found (${id})`) : "none";
    console.log(`cmux workspace for "${groupName}": ${state}`);
    console.log(`  panes: ${buildLayout(config, group).panes.join(", ")}`);
}
