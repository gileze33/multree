import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parse } from "yaml";
import { detectCycle } from "./scheduler.ts";
import type {
    MainCheckoutAction,
    MultreeConfig,
    RepoConfig,
    UpdateStrategy,
} from "./types.ts";

export const DEFAULT_PROFILE = "default";
const ALIASES_FILENAME = "aliases.json";
// Same character class as group names — keeps profile names safe in filenames.
const PROFILE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export interface ResolveOptions {
    profile?: string;
    home?: string;
}

export function resolveMultreeHome(home?: string): string {
    if (home !== undefined) {
        return resolve(home);
    }
    const env = process.env.MULTREE_HOME;
    if (env && env.length > 0) {
        return resolve(env);
    }
    return join(homedir(), ".multree");
}

export function resolveProfileName(profile?: string): string {
    const raw = profile ?? process.env.MULTREE_PROFILE ?? DEFAULT_PROFILE;
    if (!PROFILE_NAME_RE.test(raw)) {
        throw new Error(
            `Invalid profile name: ${raw} (alphanumerics, dot, underscore, hyphen only)`,
        );
    }
    return raw;
}

export function aliasesPath(home: string): string {
    return join(home, ALIASES_FILENAME);
}

export function loadAliases(home: string): Record<string, string> {
    const p = aliasesPath(home);
    if (!existsSync(p)) {
        return {};
    }
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${p}: expected a JSON object of { alias: target } entries`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v !== "string") {
            throw new Error(`${p}: alias ${k} target must be a string (got ${typeof v})`);
        }
        if (!PROFILE_NAME_RE.test(k) || !PROFILE_NAME_RE.test(v)) {
            throw new Error(`${p}: alias ${k} -> ${v} has an invalid profile name`);
        }
        out[k] = v;
    }
    return out;
}

export function profileFilePath(home: string, profile: string): string {
    return join(home, `${profile}.yaml`);
}

export interface ResolvedManifest {
    home: string;
    profile: string;
    resolvedProfile: string;
    path: string;
    aliased: boolean;
}

// Single source of truth for profile resolution. One alias hop only — the
// alias map is kept flat by `multree profile alias` so we never need to chain.
export function resolveManifest(opts: ResolveOptions = {}): ResolvedManifest {
    const home = resolveMultreeHome(opts.home);
    const profile = resolveProfileName(opts.profile);
    const aliases = loadAliases(home);
    const target = aliases[profile];
    const resolvedProfile = target ?? profile;
    return {
        home,
        profile,
        resolvedProfile,
        path: profileFilePath(home, resolvedProfile),
        aliased: target !== undefined,
    };
}

export function loadConfig(opts: ResolveOptions = {}): { config: MultreeConfig; path: string } {
    const resolved = resolveManifest(opts);
    if (!existsSync(resolved.path)) {
        throw new Error(buildMissingManifestError(resolved));
    }
    const config = parse(readFileSync(resolved.path, "utf-8")) as MultreeConfig;
    validate(config);
    return { config, path: resolved.path };
}

function buildMissingManifestError(resolved: ResolvedManifest): string {
    const aliasNote = resolved.aliased
        ? ` (profile "${resolved.profile}" is aliased to "${resolved.resolvedProfile}")`
        : "";
    return (
        `No multree manifest at ${resolved.path}${aliasNote}.\n` +
        `Create it (copy multree.config.example.yaml from the repo) or pick a different profile ` +
        `with --profile <name> or $MULTREE_PROFILE.`
    );
}

function validate(cfg: MultreeConfig): void {
    if (cfg.version !== 1) {
        throw new Error(`Unsupported config version: ${cfg.version} (expected 1)`);
    }
    if (!cfg.repos || Object.keys(cfg.repos).length === 0) {
        throw new Error("Config has no repos defined");
    }
    for (const [name, repo] of Object.entries(cfg.repos)) {
        if (!repo.path) {
            throw new Error(`Repo "${name}" is missing required field: path`);
        }
    }
    validateDependsOn(cfg);
}

function validateDependsOn(cfg: MultreeConfig): void {
    const known = Object.keys(cfg.repos);
    const depsOf: Record<string, string[]> = {};
    for (const [name, repo] of Object.entries(cfg.repos)) {
        if (!repo.depends_on) {
            continue;
        }
        for (const dep of repo.depends_on) {
            if (!cfg.repos[dep]) {
                throw new Error(`Repo "${name}" depends_on unknown repo "${dep}"`);
            }
            if (dep === name) {
                throw new Error(`Repo "${name}" depends_on itself`);
            }
        }
        depsOf[name] = repo.depends_on;
    }
    const cycle = detectCycle(known, depsOf);
    if (cycle) {
        throw new Error(`depends_on cycle: ${cycle.join(" -> ")}`);
    }
}

export function expandPath(p: string): string {
    if (p.startsWith("~/")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

export function resolveWorktreeRoot(cfg: MultreeConfig): string {
    return expandPath(cfg.worktree_root ?? "~/dev/worktree");
}

export function resolveBranchBase(repoCfg: { branch_base?: string }): string {
    return repoCfg.branch_base ?? "origin/main";
}

export function resolveUpdateStrategy(
    cfg: MultreeConfig,
    repoCfg: RepoConfig,
): UpdateStrategy {
    return repoCfg.update_strategy ?? cfg.update_strategy ?? "rebase";
}

export function canPush(repoCfg: RepoConfig): boolean {
    return repoCfg.push !== false;
}

export function resolveMainCheckoutAction(
    cfg: MultreeConfig,
    repoCfg: RepoConfig,
): MainCheckoutAction {
    return repoCfg.main_checkout_action ?? cfg.main_checkout_action ?? "switch";
}

// Local branch name implied by a `branch_base` like "origin/develop" or
// just "develop". Used as the default destination when we have to free a
// branch from the main checkout via "switch".
export function defaultBranchFromBase(repoCfg: RepoConfig): string {
    const base = repoCfg.branch_base ?? "origin/main";
    // Strip the leading remote name segment (everything up to and including
    // the first slash) if present, otherwise return as-is.
    const slash = base.indexOf("/");
    return slash === -1 ? base : base.slice(slash + 1);
}
