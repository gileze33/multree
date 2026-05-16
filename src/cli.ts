#!/usr/bin/env node
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addCommand } from "./commands/add.ts";
import { createCommand } from "./commands/create.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { listCommand } from "./commands/list.ts";
import { pushCommand } from "./commands/push.ts";
import { removeCommand } from "./commands/remove.ts";
import { rewireCommand } from "./commands/rewire.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { updateCommand } from "./commands/update.ts";
import { loadConfig } from "./config.ts";
import { toolCommand } from "./tools.ts";
import type { UpdateStrategy } from "./types.ts";

const BUILTIN_COMMANDS = new Set([
    "create",
    "add",
    "remove",
    "list",
    "show",
    "rewire",
    "destroy",
    "update",
    "status",
    "push",
    "help",
    "--help",
    "-h",
    "--version",
    "-v",
]);

function readVersion(): string {
    try {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

interface ParsedArgs {
    cmd: string;
    positional: string[];
    flags: Record<string, string | true>;
}

function parseArgs(): ParsedArgs {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? "help";
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i++;
            }
        } else {
            positional.push(a);
        }
    }
    return { cmd, positional, flags };
}

function help(): void {
    let toolsLine = "";
    try {
        const { config } = loadConfig();
        const tools = Object.keys(config.tools ?? {});
        if (tools.length > 0) {
            toolsLine = `\nTools (from manifest):\n  multree <${tools.join("|")}> <name>\n`;
        }
    } catch {
        // ignore missing/broken config in help
    }

    console.log(`multree — multi-repo git worktree group orchestrator

Usage:
  multree create <name> --include <repo,repo,...> [--branch <branch>] [--from <branch>] [--from-<repo> <branch> ...]
  multree add <name> <repo>
  multree remove <name> <repo>
  multree list
  multree show <name>
  multree status <name> [--fetch]
  multree update <name> [--strategy rebase|merge]
  multree push <name> [--set-upstream]
  multree rewire <name>
  multree destroy <name>
${toolsLine}
Manifest: $MULTREE_CONFIG, or ~/multree.config.yaml by default.
State: each group's .multree.json inside its group folder under worktree_root.
`);
}

function collectFromOverrides(
    flags: Record<string, string | true>,
    includeKeys: string[],
): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(flags)) {
        if (!k.startsWith("from-")) {
            continue;
        }
        const repoKey = k.slice("from-".length);
        if (typeof v !== "string") {
            throw new Error(`--${k} requires a branch value`);
        }
        if (!includeKeys.includes(repoKey)) {
            // Surface the error later (create.ts validates against include),
            // but only collect overrides whose key is plausible to avoid
            // shadowing global flags like --from-this-other-thing.
        }
        overrides[repoKey] = v;
    }
    return overrides;
}

async function main(): Promise<void> {
    const { cmd, positional, flags } = parseArgs();

    try {
        switch (cmd) {
            case "create": {
                const name = positional[0];
                if (!name) {
                    throw new Error("create requires a group name");
                }
                if (typeof flags.include !== "string") {
                    throw new Error("create requires --include <repo,...>");
                }
                const include = flags.include.split(",").map(s => s.trim()).filter(Boolean);
                if (include.length === 0) {
                    throw new Error("--include must list at least one repo");
                }
                const branch = typeof flags.branch === "string" ? flags.branch : undefined;
                const from = typeof flags.from === "string" ? flags.from : undefined;
                const branchesByRepo = collectFromOverrides(flags, include);
                await createCommand({ name, include, branch, from, branchesByRepo });
                break;
            }
            case "add": {
                const [name, repo] = positional;
                if (!name || !repo) {
                    throw new Error("add requires <group-name> <repo>");
                }
                await addCommand(name, repo);
                break;
            }
            case "remove": {
                const [name, repo] = positional;
                if (!name || !repo) {
                    throw new Error("remove requires <group-name> <repo>");
                }
                removeCommand(name, repo);
                break;
            }
            case "list":
                listCommand();
                break;
            case "show":
                if (!positional[0]) {
                    throw new Error("show requires a group name");
                }
                showCommand(positional[0]);
                break;
            case "status": {
                if (!positional[0]) {
                    throw new Error("status requires a group name");
                }
                statusCommand({ name: positional[0], fetch: flags.fetch === true });
                break;
            }
            case "update": {
                if (!positional[0]) {
                    throw new Error("update requires a group name");
                }
                const strategy = typeof flags.strategy === "string"
                    ? (flags.strategy as UpdateStrategy)
                    : undefined;
                updateCommand({ name: positional[0], strategy });
                break;
            }
            case "push": {
                if (!positional[0]) {
                    throw new Error("push requires a group name");
                }
                pushCommand({
                    name: positional[0],
                    setUpstream: flags["set-upstream"] === true,
                });
                break;
            }
            case "rewire":
                if (!positional[0]) {
                    throw new Error("rewire requires a group name");
                }
                rewireCommand(positional[0]);
                break;
            case "destroy":
                if (!positional[0]) {
                    throw new Error("destroy requires a group name");
                }
                destroyCommand(positional[0]);
                break;
            case "help":
            case "--help":
            case "-h":
                help();
                break;
            case "--version":
            case "-v":
                console.log(readVersion());
                break;
            default: {
                // Fall through to tool dispatch.
                if (BUILTIN_COMMANDS.has(cmd)) {
                    console.error(`Unknown command: ${cmd}\n`);
                    help();
                    process.exit(1);
                }
                if (!positional[0]) {
                    throw new Error(`${cmd} requires a group name`);
                }
                toolCommand(cmd, positional[0]);
            }
        }
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

main();
