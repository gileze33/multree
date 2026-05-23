import { execFileSync, execSync } from "child_process";
import { loadConfig } from "./config.ts";
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

function substituteCwd(template: string, cwd: string): string {
    return template.replace(/\{cwd\}/g, cwd);
}

// OSC 0: set icon + window title, terminated by BEL. iTerm maps this to the
// session name, which drives the tab title for the active pane. Tool names
// come from manifest keys and group names are validated to [a-zA-Z0-9._-]+,
// so neither can smuggle a control byte that breaks out of the sequence.
export function terminalTitleSequence(title: string): string {
    return `\x1b]0;${title}\x07`;
}

// iTerm2 proprietary OSC 1337 badge: a label painted over the pane,
// independent of the title, so an inner app that rewrites the title (e.g.
// `claude`) can't clobber it. The format string is base64-encoded. Other
// terminals ignore the unknown OSC.
export function itermBadgeSequence(text: string): string {
    const encoded = Buffer.from(text, "utf-8").toString("base64");
    return `\x1b]1337;SetBadgeFormat=${encoded}\x07`;
}

function applyTerminalContext(toolName: string, groupName: string): void {
    if (!process.stdout.isTTY) {
        return;
    }
    process.stdout.write(terminalTitleSequence(`${toolName}: ${groupName}`));
    process.stdout.write(itermBadgeSequence(groupName));
}

function runShellCommand(command: string, cwd: string): void {
    const resolved = substituteCwd(command, cwd);
    execSync(resolved, { cwd, stdio: "inherit", shell: "/bin/bash" });
}

function runArgvCommand(argv: string[], cwd: string): void {
    if (argv.length === 0) {
        throw new Error("tool command argv is empty");
    }
    const [bin, ...rest] = argv.map(a => substituteCwd(a, cwd));
    execFileSync(bin, rest, { cwd, stdio: "inherit" });
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
    applyTerminalContext(toolName, group.name);

    try {
        if (Array.isArray(tool.command)) {
            runArgvCommand(tool.command, cwd);
        } else {
            runShellCommand(tool.command, cwd);
        }
    } catch (err) {
        const code = (err as { status?: number }).status;
        if (typeof code === "number") {
            process.exit(code);
        }
        throw err;
    }
}
