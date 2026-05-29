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

// Set by the CLI's global-flag pre-pass for the lifetime of the process. We
// keep this in module state rather than writing to process.env so that the
// flag value doesn't leak into child processes (tool dispatch, the background
// update check) via inherited env.
let profileFromFlag: string | undefined;

export function setProfileFromFlag(name: string | undefined): void {
    profileFromFlag = name;
}

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

// True iff $MULTREE_HOME is explicitly set to a non-empty value. Used to
// distinguish "user typo'd MULTREE_HOME" from "user hasn't set up multree yet"
// when surfacing missing-directory errors.
function isMultreeHomeExplicit(): boolean {
    const env = process.env.MULTREE_HOME;
    return env !== undefined && env.length > 0;
}

export function resolveProfileName(profile?: string): string {
    const raw =
        profile ?? profileFromFlag ?? process.env.MULTREE_PROFILE ?? DEFAULT_PROFILE;
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

export interface LoadedConfig {
    config: MultreeConfig;
    path: string;
    // Resolved profile name (after one alias hop) and the $MULTREE_HOME
    // directory it was loaded from. Commands thread these into the variables
    // ledger so allocations are keyed by profile and shared across profiles.
    profile: string;
    home: string;
}

export function loadConfig(opts: ResolveOptions = {}): LoadedConfig {
    const resolved = resolveManifest(opts);
    // Typo-protection: an explicitly-set $MULTREE_HOME pointing at a missing
    // directory is almost always a typo, not a "you haven't set up multree
    // yet" case. Surface a sharper error before the regular missing-yaml one.
    if (opts.home === undefined && isMultreeHomeExplicit() && !existsSync(resolved.home)) {
        throw new Error(
            `$MULTREE_HOME points at a directory that does not exist: ${resolved.home}\n` +
                `Check the value for typos, create the directory, or unset $MULTREE_HOME to use ${join(homedir(), ".multree")}.`,
        );
    }
    if (!existsSync(resolved.path)) {
        throw new Error(buildMissingManifestError(resolved));
    }
    const config = parse(readFileSync(resolved.path, "utf-8")) as MultreeConfig;
    validate(config);
    return {
        config,
        path: resolved.path,
        profile: resolved.resolvedProfile,
        home: resolved.home,
    };
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
        validateVariables(name, repo);
    }
    validateDependsOn(cfg);
}

// Variable names share the character class that wiring templates accept for the
// `{<repo>.<key>}` form, so an allocated value is always referenceable.
const VARIABLE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function validateVariables(repoName: string, repo: RepoConfig): void {
    if (!repo.variables) {
        return;
    }
    for (const [varName, spec] of Object.entries(repo.variables)) {
        const where = `Repo "${repoName}" variable "${varName}"`;
        if (!VARIABLE_NAME_RE.test(varName)) {
            throw new Error(
                `${where}: invalid name (alphanumerics, underscore, hyphen only)`,
            );
        }
        if (spec.type !== undefined && spec.type !== "number") {
            throw new Error(
                `${where}: unsupported type "${spec.type}" (only "number" is supported)`,
            );
        }
        if (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)) {
            throw new Error(`${where}: min and max must be integers`);
        }
        if (spec.min > spec.max) {
            throw new Error(`${where}: min (${spec.min}) must be <= max (${spec.max})`);
        }
        if (spec.default !== undefined && !Number.isInteger(spec.default)) {
            throw new Error(`${where}: default must be an integer`);
        }
    }
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

// Matches `${NAME}` references. Captures everything up to the next `}` so we
// can validate the name explicitly and report the bad token in the error,
// rather than silently leaving e.g. `${a b}` untouched.
const ENV_VAR_PLACEHOLDER_RE = /\$\{([^}]*)\}/g;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function expandEnvVars(p: string): string {
    return p.replace(ENV_VAR_PLACEHOLDER_RE, (_match, name: string) => {
        if (!ENV_VAR_NAME_RE.test(name)) {
            throw new Error(
                `Invalid env var name "${name}" in manifest path "${p}" ` +
                    `(expected ${ENV_VAR_NAME_RE.source})`,
            );
        }
        const value = process.env[name];
        // Empty string is treated as undefined on purpose: silently substituting
        // "" turns `${BASE}/api` into `/api`, which is exactly the dangerous
        // case (worktree created in the wrong place, or destroy/teardown
        // pointed at the wrong tree).
        if (value === undefined || value === "") {
            throw new Error(
                `Env var "${name}" referenced in manifest path "${p}" is unset or empty ` +
                    `(export ${name} or remove the placeholder).`,
            );
        }
        return value;
    });
}

// Resolves `${VAR}` references first, then a leading `~/`. Env expansion is
// deliberately limited to this function so it only applies to the two fields
// every caller routes through here: top-level `worktree_root` (via
// resolveWorktreeRoot) and per-repo `path`. Hook command strings, prime_artifact
// paths, tools commands, etc. never pass through expandPath, so a `${VAR}`
// literal there stays intact for the shell to handle at execution time.
export function expandPath(p: string): string {
    const withEnv = expandEnvVars(p);
    if (withEnv.startsWith("~/")) {
        return join(homedir(), withEnv.slice(2));
    }
    return withEnv;
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
