import { addCommand } from "./commands/add.ts";
import { createCommand } from "./commands/create.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { rewireCommand } from "./commands/rewire.ts";
import { showCommand } from "./commands/show.ts";
import { loadConfig } from "./config.ts";
import { toolCommand } from "./tools.ts";

const BUILTIN_COMMANDS = new Set([
    "create",
    "add",
    "remove",
    "list",
    "show",
    "rewire",
    "destroy",
    "help",
    "--help",
    "-h",
]);

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
  multree create <name> --include <repo,repo,...> [--branch <branch>]
  multree add <name> <repo>
  multree remove <name> <repo>
  multree list
  multree show <name>
  multree rewire <name>
  multree destroy <name>
${toolsLine}
Manifest: $MULTREE_CONFIG, or ~/multree.config.yaml by default.
State: each group's .multree.json inside its group folder under worktree_root.
`);
}

async function main(): Promise<void> {
    const { cmd, positional, flags } = parseArgs();

    try {
        switch (cmd) {
            case "create": {
                const name = positional[0];
                if (!name) throw new Error("create requires a group name");
                if (typeof flags.include !== "string") {
                    throw new Error("create requires --include <repo,...>");
                }
                const include = flags.include.split(",").map(s => s.trim()).filter(Boolean);
                if (include.length === 0) throw new Error("--include must list at least one repo");
                const branch = typeof flags.branch === "string" ? flags.branch : undefined;
                await createCommand({ name, include, branch });
                break;
            }
            case "add": {
                const [name, repo] = positional;
                if (!name || !repo) throw new Error("add requires <group-name> <repo>");
                await addCommand(name, repo);
                break;
            }
            case "remove": {
                const [name, repo] = positional;
                if (!name || !repo) throw new Error("remove requires <group-name> <repo>");
                removeCommand(name, repo);
                break;
            }
            case "list":
                listCommand();
                break;
            case "show":
                if (!positional[0]) throw new Error("show requires a group name");
                showCommand(positional[0]);
                break;
            case "rewire":
                if (!positional[0]) throw new Error("rewire requires a group name");
                rewireCommand(positional[0]);
                break;
            case "destroy":
                if (!positional[0]) throw new Error("destroy requires a group name");
                destroyCommand(positional[0]);
                break;
            case "help":
            case "--help":
            case "-h":
                help();
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
