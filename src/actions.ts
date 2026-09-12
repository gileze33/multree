import { join } from "path";
import { loadConfig } from "./config.ts";
import { runForeground } from "./exec.ts";
import { loadGroup } from "./state.ts";
import type { ActionSpec, AppConfig, GroupState, MultreeConfig, TargetSpec } from "./types.ts";
import { buildContext, buildMetaContext, resolveTemplate } from "./wiring.ts";

// Reserved target key: the default subdir for the target's actions, not itself
// an action verb.
export const RESERVED_TARGET_KEY = "cwd";

// An app's only verb, from its `run` field.
const APP_RUN_VERB = "run";

export interface ResolvedAction {
    // The member (repo or app) the target belongs to.
    repo: string;
    target: string;
    action: string;
    command: string | string[];
    cwd: string; // absolute
    // For an app target: the app's templated `env` map, resolved and injected
    // into the child process by actionCommand. Absent for repo command targets.
    envTemplate?: Record<string, string>;
}

// Every action verb dispatchable in the manifest. Verbs are implicit: any
// action key under a repo's command targets, plus an app's `run`, becomes
// dispatchable — mirroring how any `tools.<name>` key becomes a verb.
export function collectActionVerbs(config: MultreeConfig): Set<string> {
    const verbs = new Set<string>();
    for (const repo of Object.values(config.repos)) {
        for (const target of Object.values(repo.commands ?? {})) {
            for (const action of actionsOf(target)) {
                verbs.add(action);
            }
        }
    }
    for (const app of Object.values(config.apps ?? {})) {
        if (app.run !== undefined) {
            verbs.add(APP_RUN_VERB);
        }
    }
    return verbs;
}

function actionsOf(target: TargetSpec): string[] {
    return Object.keys(target).filter(key => key !== RESERVED_TARGET_KEY);
}

// The verbs an app target answers to, for help/error text.
function appVerbs(app: AppConfig): string[] {
    return app.run !== undefined ? [APP_RUN_VERB] : [];
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
    for (const memberKey of Object.keys(group.members)) {
        for (const [target, spec] of Object.entries(config.repos[memberKey]?.commands ?? {})) {
            if (spec[action] !== undefined) {
                targets.push(target);
            }
        }
        const app = config.apps?.[memberKey];
        if (app && action === APP_RUN_VERB && app.run !== undefined) {
            targets.push(memberKey);
        }
    }
    return [...new Set(targets)].sort();
}

interface RepoTargetMatch {
    kind: "repo";
    repo: string;
    path: string;
    spec: TargetSpec;
}
interface AppTargetMatch {
    kind: "app";
    repo: string; // the app name (a member key)
    path: string; // the app's scratchpad dir
    app: AppConfig;
}
type TargetMatch = RepoTargetMatch | AppTargetMatch;

// Resolve `<action> <group> <target>` to a concrete command + absolute cwd.
// Targets are addressed flat across the group: a name defined by two members
// (two repo command targets, or a repo command target and an app) is an error
// (rename one) rather than something to disambiguate. Pure: no fs / no exec.
export function resolveAction(
    config: MultreeConfig,
    group: GroupState,
    action: string,
    target: string,
): ResolvedAction {
    const matches: TargetMatch[] = [];
    for (const [memberKey, member] of Object.entries(group.members)) {
        const spec = config.repos[memberKey]?.commands?.[target];
        if (spec) {
            matches.push({ kind: "repo", repo: memberKey, path: member.path, spec });
        }
    }
    // An app is itself a target, named by the app key. Only when it's a live
    // member of the group.
    const appCfg = config.apps?.[target];
    if (appCfg && group.members[target]) {
        matches.push({ kind: "app", repo: target, path: group.members[target].path, app: appCfg });
    }

    if (matches.length === 0) {
        const hint = availableTargets(config, group, action);
        const tail = hint.length > 0 ? ` Available for "${action}": ${hint.join(", ")}.` : "";
        throw new Error(`No target "${target}" in group "${group.name}".${tail}`);
    }
    if (matches.length > 1) {
        const repos = matches.map(m => m.repo).join(", ");
        throw new Error(
            `Target "${target}" is defined by more than one member in group "${group.name}" ` +
                `(${repos}). Target names must be unique; rename one in the manifest.`,
        );
    }

    const match = matches[0];
    if (match.kind === "app") {
        const value = action === APP_RUN_VERB ? match.app.run : undefined;
        if (value === undefined) {
            const list = appVerbs(match.app);
            throw new Error(
                `App "${target}" has no action "${action}". Available: ` +
                    `${list.length > 0 ? list.join(", ") : "(none)"}.`,
            );
        }
        const { command, cwd } = normalise(value);
        return {
            repo: match.repo,
            target,
            action,
            command,
            cwd: cwd ? join(match.path, cwd) : match.path,
            envTemplate: match.app.env,
        };
    }

    const value = action === RESERVED_TARGET_KEY ? undefined : match.spec[action];
    if (value === undefined) {
        const actions = actionsOf(match.spec);
        const list = actions.length > 0 ? actions.sort().join(", ") : "(none)";
        throw new Error(
            `Target "${target}" (repo "${match.repo}") has no action "${action}". Available: ${list}.`,
        );
    }

    const { command, cwd } = normalise(value);
    const subdir = cwd ?? match.spec.cwd;
    return {
        repo: match.repo,
        target,
        action,
        command,
        cwd: subdir ? join(match.path, subdir) : match.path,
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
    // App targets carry a templated `env`; resolve it against the wiring context
    // and inject it into the child process. Repo command targets have none.
    let env: Record<string, string> | undefined;
    if (resolved.envTemplate) {
        const ctx = buildContext(config, group);
        const meta = buildMetaContext(group);
        env = {};
        for (const [k, tmpl] of Object.entries(resolved.envTemplate)) {
            env[k] = resolveTemplate(tmpl, ctx, meta);
        }
    }
    runForeground(resolved.command, resolved.cwd, env);
}
