import { join } from "path";
import { loadConfig } from "./config.ts";
import { runForeground } from "./exec.ts";
import { loadGroup } from "./state.ts";
import type { ActionSpec, GroupState, MultreeConfig, TargetSpec } from "./types.ts";

// Reserved target key: the default subdir for the target's actions, not itself
// an action verb.
export const RESERVED_TARGET_KEY = "cwd";

export interface ResolvedAction {
    repo: string;
    target: string;
    action: string;
    command: string | string[];
    cwd: string; // absolute
}

// Every action verb declared by any target in any repo. Verbs are implicit:
// whatever you name an action key (other than the reserved `cwd`) becomes a
// dispatchable verb, mirroring how any `tools.<name>` key becomes one.
export function collectActionVerbs(config: MultreeConfig): Set<string> {
    const verbs = new Set<string>();
    for (const repo of Object.values(config.repos)) {
        for (const target of Object.values(repo.commands ?? {})) {
            for (const action of actionsOf(target)) {
                verbs.add(action);
            }
        }
    }
    return verbs;
}

function actionsOf(target: TargetSpec): string[] {
    return Object.keys(target).filter(key => key !== RESERVED_TARGET_KEY);
}

function normalise(value: ActionSpec): { command: string | string[]; cwd?: string } {
    if (typeof value === "string" || Array.isArray(value)) {
        return { command: value };
    }
    return { command: value.command, cwd: value.cwd };
}

// Targets across the group that expose the given action, for help/error text.
function availableTargets(config: MultreeConfig, group: GroupState, action: string): string[] {
    const targets: string[] = [];
    for (const repoKey of Object.keys(group.members)) {
        for (const [target, spec] of Object.entries(config.repos[repoKey]?.commands ?? {})) {
            if (spec[action] !== undefined) {
                targets.push(target);
            }
        }
    }
    return [...new Set(targets)].sort();
}

// Resolve `<action> <group> <target>` to a concrete command + absolute cwd.
// Targets are addressed flat: a name defined by two member repos is an error
// (rename one) rather than something to disambiguate. Pure: no fs / no exec.
export function resolveAction(
    config: MultreeConfig,
    group: GroupState,
    action: string,
    target: string,
): ResolvedAction {
    const matches: { repo: string; path: string; spec: TargetSpec }[] = [];
    for (const [repoKey, member] of Object.entries(group.members)) {
        const spec = config.repos[repoKey]?.commands?.[target];
        if (spec) {
            matches.push({ repo: repoKey, path: member.path, spec });
        }
    }

    if (matches.length === 0) {
        const hint = availableTargets(config, group, action);
        const tail = hint.length > 0 ? ` Available for "${action}": ${hint.join(", ")}.` : "";
        throw new Error(`No target "${target}" in group "${group.name}".${tail}`);
    }
    if (matches.length > 1) {
        const repos = matches.map(m => m.repo).join(", ");
        throw new Error(
            `Target "${target}" is defined by more than one repo in group "${group.name}" ` +
                `(${repos}). Target names must be unique; rename one in the manifest.`,
        );
    }

    const { repo, path, spec } = matches[0];
    const value = action === RESERVED_TARGET_KEY ? undefined : spec[action];
    if (value === undefined) {
        const actions = actionsOf(spec);
        const list = actions.length > 0 ? actions.sort().join(", ") : "(none)";
        throw new Error(
            `Target "${target}" (repo "${repo}") has no action "${action}". Available: ${list}.`,
        );
    }

    const { command, cwd } = normalise(value);
    const subdir = cwd ?? spec.cwd;
    return {
        repo,
        target,
        action,
        command,
        cwd: subdir ? join(path, subdir) : path,
    };
}

export function actionCommand(action: string, groupName: string, target: string | undefined): void {
    const { config } = loadConfig();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }

    if (target === undefined) {
        const targets = availableTargets(config, group, action);
        if (targets.length === 0) {
            throw new Error(`No target defines action "${action}" in group "${groupName}".`);
        }
        console.log(`${action} targets in "${groupName}": ${targets.join(", ")}`);
        return;
    }

    const resolved = resolveAction(config, group, action, target);
    console.log(`${action} ${resolved.target}: ${resolved.cwd}`);
    runForeground(resolved.command, resolved.cwd);
}
