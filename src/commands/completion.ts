import { collectActionVerbs } from "../actions.ts";
import { loadAliases, loadConfig, resolveMultreeHome, setProfileFromFlag } from "../config.ts";
import {
    BASH_COMPLETION,
    computeCandidates,
    SUBCOMMANDS,
    ZSH_COMPLETION,
    type CompletionContext,
} from "../completion.ts";
import { listGroups } from "../state.ts";
import { listProfileFiles } from "./profile.ts";

// `multree completion <bash|zsh>` — print the wrapper script for the named shell.
export function completionCommand(args: string[]): void {
    const shell = args[0];
    if (shell === "bash") {
        process.stdout.write(BASH_COMPLETION);
        return;
    }
    if (shell === "zsh") {
        process.stdout.write(ZSH_COMPLETION);
        return;
    }
    throw new Error(
        `multree completion requires a shell: bash | zsh\n` +
            `  Bash: add to ~/.bashrc:  eval "$(multree completion bash)"\n` +
            `  Zsh:  add to ~/.zshrc:   eval "$(multree completion zsh)"`,
    );
}

function gatherProfiles(): string[] {
    try {
        const home = resolveMultreeHome();
        const files = listProfileFiles(home);
        const aliases = Object.keys(loadAliases(home));
        return [...new Set([...files, ...aliases])].sort();
    } catch {
        return [];
    }
}

// Build the completion context, failure-soft at every step: a missing or broken
// manifest must still let the shell complete built-in subcommands rather than
// dump an error into the user's prompt.
function gatherContext(): CompletionContext {
    let tools: string[] = [];
    let repos: string[] = [];
    let groups: CompletionContext["groups"] = [];
    let actions: string[] = [];
    let actionTargets: Record<string, string[]> = {};
    try {
        const { config } = loadConfig();
        tools = Object.keys(config.tools ?? {}).sort();
        repos = Object.keys(config.repos ?? {}).sort();
        groups = listGroups(config)
            .map(g => ({ name: g.name, members: Object.keys(g.members).sort() }))
            .sort((a, b) => a.name.localeCompare(b.name));
        actions = [...collectActionVerbs(config)].sort();
        actionTargets = buildActionTargets(config);
    } catch {
        // No usable manifest — built-ins below are still completable.
    }
    return {
        commands: [...SUBCOMMANDS],
        tools,
        repos,
        groups,
        profiles: gatherProfiles(),
        actions,
        actionTargets,
    };
}

// action verb -> sorted, de-duplicated target names that declare it, across all
// repos. Manifest-level (not group-scoped) — enough to complete the target slot.
function buildActionTargets(config: Parameters<typeof collectActionVerbs>[0]): Record<string, string[]> {
    const byAction: Record<string, Set<string>> = {};
    for (const repo of Object.values(config.repos ?? {})) {
        for (const [target, spec] of Object.entries(repo.commands ?? {})) {
            for (const action of Object.keys(spec)) {
                if (action === "cwd") {
                    continue;
                }
                (byAction[action] ??= new Set()).add(target);
            }
        }
    }
    const out: Record<string, string[]> = {};
    for (const [action, targets] of Object.entries(byAction)) {
        out[action] = [...targets].sort();
    }
    return out;
}

// Hidden `multree __complete <words...>` — the brain the wrapper scripts call on
// every TAB. Reads the raw words (the in-progress command line minus the program
// name, with the cursor word last) and prints newline-separated candidates.
export function completeCommand(words: string[]): void {
    // Honour a `--profile <name>` already on the line so groups/repos come from
    // the profile being completed against, not the default.
    const profile = extractProfile(words);
    if (profile) {
        setProfileFromFlag(profile);
    }
    const candidates = computeCandidates(gatherContext(), words);
    if (candidates.length > 0) {
        process.stdout.write(candidates.join("\n") + "\n");
    }
}

function extractProfile(words: string[]): string | undefined {
    const i = words.indexOf("--profile");
    if (i !== -1 && i + 1 < words.length) {
        const value = words[i + 1];
        if (value && !value.startsWith("--")) {
            return value;
        }
    }
    return undefined;
}
