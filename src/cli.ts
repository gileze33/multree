#!/usr/bin/env node
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { actionCommand, collectActionVerbs } from "./actions.ts";
import { addCommand } from "./commands/add.ts";
import { cmuxCommand } from "./commands/cmux.ts";
import { completeCommand, completionCommand } from "./commands/completion.ts";
import { createCommand } from "./commands/create.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { listCommand } from "./commands/list.ts";
import { profileCommand } from "./commands/profile.ts";
import { pushCommand } from "./commands/push.ts";
import { removeCommand } from "./commands/remove.ts";
import { rewireCommand } from "./commands/rewire.ts";
import { shellCommand } from "./commands/shell.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { updateCommand } from "./commands/update.ts";
import { SUBCOMMANDS } from "./completion.ts";
import { loadConfig, setProfileFromFlag } from "./config.ts";
import { toolCommand } from "./tools.ts";
import type { UpdateStrategy } from "./types.ts";
import { kickBackgroundCheck, notifyIfNewer, runUpdateCheck } from "./update-check.ts";

// Derived from the canonical SUBCOMMANDS list (the completion source of truth)
// plus the flag-style aliases the switch below also accepts. Anything not here
// falls through to manifest tool dispatch.
const BUILTIN_COMMANDS = new Set<string>([...SUBCOMMANDS, "--help", "-h", "--version", "-v"]);

// Global flags consumed before subcommand dispatch. Stripped from argv and
// stashed in module-level state in config.ts so command modules don't need to
// thread them through, and so they don't leak into child processes (tool
// dispatch, the background update check) via process.env.
function stripGlobalFlags(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--profile") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error(`--profile requires a value`);
            }
            setProfileFromFlag(value);
            i++;
            continue;
        }
        out.push(a);
    }
    return out;
}

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
    const argv = stripGlobalFlags(process.argv.slice(2));
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
        } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
            // Short flags are boolean only — no value form. `-f` is recorded
            // as `flags.f = true`; subcommands map it onto a long name.
            flags[a.slice(1)] = true;
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
        const actions = [...collectActionVerbs(config)].sort();
        if (actions.length > 0) {
            toolsLine += `\nRepo commands (from manifest):\n  multree <${actions.join("|")}> <name> <target>\n`;
        }
    } catch {
        // ignore missing/broken config in help
    }

    console.log(`multree — multi-repo git worktree group orchestrator

Usage:
  multree [--profile <name>] <command> [...]

  multree create <name> [--include <repo,repo,...>] [--branch <branch>] [--from <branch>] [--from-<repo> <branch> ...]
                                                    [--jobs <N>] [--plan] [--resume] [--verbose]
  multree add <name> <repo> [--verbose]
  multree remove <name> <repo>
  multree list
  multree show <name>
  multree status <name> [--fetch]
  multree update <name> [--strategy rebase|merge]
  multree push <name> [--include <repo,...>] [--set-upstream] [--force|-f]
  multree rewire <name>
  multree destroy <name>
  multree profile [list|path|alias|unalias]
  multree shell <name> [<repo>]
  multree cmux <up|down|status> <name> [--print] [--focus]
  multree completion <bash|zsh>
${toolsLine}
Manifest: <$MULTREE_HOME or ~/.multree>/<profile>.yaml. Profile resolution:
  --profile <name>  >  $MULTREE_PROFILE  >  "default"  (then aliases.json, one hop).
State: each group's .multree.json inside its group folder under worktree_root.
`);
}

function parseJobs(raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--jobs must be a positive integer (got: ${raw})`);
    }
    return Math.floor(n);
}

function requireGroup(positional: string[], cmd: string): string {
    const name = positional[0];
    if (!name) {
        throw new Error(`${cmd} requires a group name`);
    }
    return name;
}

function parseStrategy(raw: string | true | undefined): UpdateStrategy | undefined {
    if (raw === undefined || raw === true) {
        return undefined;
    }
    if (raw !== "rebase" && raw !== "merge") {
        throw new Error(`Invalid --strategy "${raw}" (expected rebase|merge)`);
    }
    return raw;
}

// Collects every `--from-<repo> <branch>` pair. Keys are not checked against the
// selected repos here: the selection may come from the manifest's
// `default_include`, which isn't known until create.ts has loaded the config —
// so create.ts owns that validation.
function collectFromOverrides(
    flags: Record<string, string | true>,
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
        overrides[repoKey] = v;
    }
    return overrides;
}

async function main(): Promise<void> {
    try {
        // Hidden shell-completion subcommand. Handled before parseArgs (which
        // would collapse `--flag value` pairs and lose token order that the
        // completer needs) and before the notify/kick flow so every TAB stays
        // silent and fast.
        const rawArgv = process.argv.slice(2);
        if (rawArgv[0] === "__complete") {
            completeCommand(rawArgv.slice(1));
            return;
        }

        const { cmd, positional, flags } = parseArgs();

        // Hidden subcommand used by the detached background process. Never emits
        // output and never recurses into the user-facing notify/kick flow.
        if (cmd === "__update-check") {
            await runUpdateCheck();
            return;
        }

        const version = readVersion();
        notifyIfNewer(version);
        kickBackgroundCheck();

        switch (cmd) {
            case "create": {
                const name = requireGroup(positional, "create");
                // A bare `--include` (no value) is a typo, not a request for the
                // manifest default — never fall back on it silently.
                if (flags.include === true) {
                    throw new Error("--include requires a repo list (e.g. --include api,frontend)");
                }
                // undefined = flag absent; create.ts falls back to default_include.
                const include = typeof flags.include === "string"
                    ? flags.include.split(",").map(s => s.trim()).filter(Boolean)
                    : undefined;
                if (include !== undefined && include.length === 0) {
                    throw new Error("--include must list at least one repo");
                }
                const branch = typeof flags.branch === "string" ? flags.branch : undefined;
                const from = typeof flags.from === "string" ? flags.from : undefined;
                const branchesByRepo = collectFromOverrides(flags);
                const jobs = typeof flags.jobs === "string" ? parseJobs(flags.jobs) : undefined;
                // --cmux forces the workspace open, --no-cmux forces it off;
                // absent leaves it to cmux.auto / the inside-cmux default.
                const cmux = flags.cmux === true ? true : flags["no-cmux"] === true ? false : undefined;
                // --group <name|current> / --no-group override cmux sidebar
                // placement; absent falls back to cmux.group (current group).
                if (flags.group === true) {
                    throw new Error("--group requires a value (a group name, or 'current')");
                }
                const group = flags["no-group"] === true
                    ? "none"
                    : typeof flags.group === "string" ? flags.group : undefined;
                await createCommand({
                    name,
                    include,
                    branch,
                    from,
                    branchesByRepo,
                    jobs,
                    plan: flags.plan === true,
                    resume: flags.resume === true,
                    verbose: flags.verbose === true,
                    cmux,
                    group,
                });
                break;
            }
            case "add": {
                const [name, repo] = positional;
                if (!name || !repo) {
                    throw new Error("add requires <group-name> <repo>");
                }
                await addCommand(name, repo, { verbose: flags.verbose === true });
                break;
            }
            case "remove": {
                const [name, repo] = positional;
                if (!name || !repo) {
                    throw new Error("remove requires <group-name> <repo>");
                }
                await removeCommand(name, repo);
                break;
            }
            case "list":
                await listCommand();
                break;
            case "show":
                showCommand(requireGroup(positional, "show"));
                break;
            case "status":
                statusCommand({
                    name: requireGroup(positional, "status"),
                    fetch: flags.fetch === true,
                });
                break;
            case "update":
                updateCommand({
                    name: requireGroup(positional, "update"),
                    strategy: parseStrategy(flags.strategy),
                });
                break;
            case "push": {
                const include = typeof flags.include === "string"
                    ? flags.include.split(",").map(s => s.trim()).filter(Boolean)
                    : undefined;
                pushCommand({
                    name: requireGroup(positional, "push"),
                    setUpstream: flags["set-upstream"] === true,
                    force: flags.force === true || flags.f === true,
                    include,
                });
                break;
            }
            case "rewire":
                rewireCommand(requireGroup(positional, "rewire"));
                break;
            case "destroy":
                await destroyCommand(requireGroup(positional, "destroy"));
                break;
            case "profile":
                profileCommand(positional);
                break;
            case "completion":
                completionCommand(positional);
                break;
            case "shell": {
                const name = requireGroup(positional, "shell");
                shellCommand(name, positional[1]);
                break;
            }
            case "cmux":
                cmuxCommand(positional, flags);
                break;
            case "help":
            case "--help":
            case "-h":
                help();
                break;
            case "--version":
            case "-v":
                console.log(version);
                break;
            default: {
                // Unknown verb: a manifest tool, a repo-command action, or an
                // error. Builtins are handled above; reaching here means cmd is
                // not one.
                if (BUILTIN_COMMANDS.has(cmd)) {
                    console.error(`Unknown command: ${cmd}\n`);
                    help();
                    process.exit(1);
                }
                const { config } = loadConfig();
                if (config.tools?.[cmd]) {
                    toolCommand(cmd, requireGroup(positional, cmd));
                } else if (collectActionVerbs(config).has(cmd)) {
                    actionCommand(cmd, requireGroup(positional, cmd), positional[1]);
                } else {
                    console.error(`Unknown command: ${cmd}\n`);
                    help();
                    process.exit(1);
                }
            }
        }
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

main();
