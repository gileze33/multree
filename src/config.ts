import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { parse } from "yaml";
import { SUBCOMMANDS } from "./completion.ts";
import { detectCycle } from "./scheduler.ts";
import type {
    ActionSpec,
    MainCheckoutAction,
    McpServerSpec,
    MemberConfig,
    MultreeConfig,
    RepoConfig,
    UpdateStrategy,
    VariableSpec,
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
        validateVariables(`Repo "${name}"`, repo.variables);
        validateCommands(name, repo, cfg);
        validateMcps(`Repo "${name}"`, repo.mcps);
    }
    validateApps(cfg);
    validateDependsOn(cfg);
    validateDefaultInclude(cfg);
    validateCmux(cfg);
    validateClaudeWorkspace(cfg);
}

function validateClaudeWorkspace(cfg: MultreeConfig): void {
    const c = cfg.claude_workspace;
    if (c === undefined) {
        return;
    }
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
        throw new Error("claude_workspace must be a map (e.g. { hoist_member_mcps: true })");
    }
    for (const key of ["hoist_member_mcps", "additional_directories"] as const) {
        if (c[key] !== undefined && typeof c[key] !== "boolean") {
            throw new Error(`claude_workspace.${key} must be a boolean`);
        }
    }
}

// Look up a member's config by name — a repo, else an app. Validation guarantees
// a name is never in both, so repos-first is unambiguous.
export function memberConfig(cfg: MultreeConfig, name: string): MemberConfig | undefined {
    return cfg.repos[name] ?? cfg.apps?.[name];
}

// True iff `name` is an app member (and not a repo).
export function isAppName(cfg: MultreeConfig, name: string): boolean {
    return cfg.apps?.[name] !== undefined && cfg.repos[name] === undefined;
}

// Every declared member name — repos then apps.
export function memberNames(cfg: MultreeConfig): string[] {
    return [...Object.keys(cfg.repos), ...Object.keys(cfg.apps ?? {})];
}

// Member names share the wiring template's `{member.key}` character class (no
// dot, which is the key separator) so an app name is always referenceable.
const MEMBER_NAME_RE = /^[A-Za-z0-9_-]+$/;

function validateApps(cfg: MultreeConfig): void {
    if (cfg.apps === undefined) {
        return;
    }
    if (typeof cfg.apps !== "object" || cfg.apps === null || Array.isArray(cfg.apps)) {
        throw new Error("apps must be a map of app name -> app config");
    }
    for (const [name, app] of Object.entries(cfg.apps)) {
        if (!MEMBER_NAME_RE.test(name)) {
            throw new Error(
                `App "${name}": invalid name (alphanumerics, underscore, hyphen only)`,
            );
        }
        if (cfg.repos[name]) {
            throw new Error(
                `App "${name}" collides with a repo of the same name; member names must be unique`,
            );
        }
        validateVariables(`App "${name}"`, app.variables);
        validateMcps(`App "${name}"`, app.mcps);
        validateAppEnv(name, app.env);
        if (app.run !== undefined) {
            validateActionCommand(`App "${name}" run`, app.run);
        }
    }
}

function validateAppEnv(appName: string, env: Record<string, string> | undefined): void {
    if (env === undefined) {
        return;
    }
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new Error(`App "${appName}" env must be a map of string -> string`);
    }
    for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") {
            throw new Error(`App "${appName}" env "${k}" must be a string (got ${typeof v})`);
        }
    }
}

function validateMcps(label: string, mcps: Record<string, McpServerSpec> | undefined): void {
    if (mcps === undefined) {
        return;
    }
    if (typeof mcps !== "object" || mcps === null || Array.isArray(mcps)) {
        throw new Error(`${label} mcps must be a map of server name -> server spec`);
    }
    for (const [name, spec] of Object.entries(mcps)) {
        const where = `${label} mcp server "${name}"`;
        if (!COMMAND_NAME_RE.test(name)) {
            throw new Error(`${where}: invalid name (alphanumerics, dot, underscore, hyphen only)`);
        }
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
            throw new Error(`${where}: must be an object`);
        }
        if (typeof spec.type !== "string" || spec.type.trim() === "") {
            throw new Error(`${where}: "type" is required (e.g. "http")`);
        }
        if (spec.type === "http" && (typeof spec.url !== "string" || spec.url.trim() === "")) {
            throw new Error(`${where}: an http server requires a non-empty "url"`);
        }
    }
}

const CMUX_PANE_KINDS = new Set(["service", "shell", "skip"]);

function validateCmux(cfg: MultreeConfig): void {
    const c = cfg.cmux;
    if (c === undefined) {
        return;
    }
    if (c.auto !== undefined && typeof c.auto !== "boolean") {
        throw new Error("cmux.auto must be a boolean");
    }
    if (c.split !== undefined) {
        if (typeof c.split !== "number" || !Number.isFinite(c.split) || c.split <= 0 || c.split >= 1) {
            throw new Error("cmux.split must be a number strictly between 0 and 1");
        }
    }
    if (c.claude !== undefined) {
        const ok =
            typeof c.claude === "string"
                ? c.claude.trim() !== ""
                : Array.isArray(c.claude) &&
                  c.claude.length > 0 &&
                  c.claude.every(item => typeof item === "string");
        if (!ok) {
            throw new Error("cmux.claude must be a non-empty string or argv array of strings");
        }
    }
    if (c.group !== undefined && (typeof c.group !== "string" || c.group.trim() === "")) {
        throw new Error('cmux.group must be a non-empty string (a group name, or "current"/"none")');
    }
    if (c.panes !== undefined) {
        if (typeof c.panes !== "object" || c.panes === null || Array.isArray(c.panes)) {
            throw new Error("cmux.panes must be a map of repo key -> pane kind(s)");
        }
        for (const [repoKey, spec] of Object.entries(c.panes)) {
            if (!cfg.repos[repoKey]) {
                throw new Error(
                    `cmux.panes references unknown repo "${repoKey}". ` +
                        `Available: ${Object.keys(cfg.repos).join(", ")}`,
                );
            }
            const kinds = Array.isArray(spec) ? spec : [spec];
            if (kinds.length === 0) {
                throw new Error(`cmux.panes.${repoKey} must not be an empty list`);
            }
            for (const kind of kinds) {
                if (!CMUX_PANE_KINDS.has(kind)) {
                    throw new Error(
                        `cmux.panes.${repoKey}: invalid kind "${kind}" (service|shell|skip)`,
                    );
                }
            }
        }
    }
}

// Target and action names share the wiring/group-name character class so they
// stay safe on the CLI and in completion.
const COMMAND_NAME_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_TARGET_KEY = "cwd";

function validateCommands(repoName: string, repo: RepoConfig, cfg: MultreeConfig): void {
    if (!repo.commands) {
        return;
    }
    const builtins = new Set<string>(SUBCOMMANDS);
    const toolNames = new Set(Object.keys(cfg.tools ?? {}));
    for (const [target, spec] of Object.entries(repo.commands)) {
        const where = `Repo "${repoName}" command target "${target}"`;
        if (!COMMAND_NAME_RE.test(target)) {
            throw new Error(`${where}: invalid name (alphanumerics, dot, underscore, hyphen only)`);
        }
        if (spec.cwd !== undefined && (typeof spec.cwd !== "string" || isAbsolute(spec.cwd))) {
            throw new Error(`${where}: cwd must be a relative path`);
        }
        const actions = Object.keys(spec).filter(key => key !== RESERVED_TARGET_KEY);
        if (actions.length === 0) {
            throw new Error(`${where}: defines no actions`);
        }
        for (const action of actions) {
            const aWhere = `${where} action "${action}"`;
            if (!COMMAND_NAME_RE.test(action)) {
                throw new Error(
                    `${aWhere}: invalid name (alphanumerics, dot, underscore, hyphen only)`,
                );
            }
            // An action verb that shadows a builtin or a tool would never
            // dispatch (builtins and tools win), so reject it at load time
            // rather than leave a silent dead command in the manifest.
            if (builtins.has(action)) {
                throw new Error(`${aWhere}: shadows the built-in subcommand "${action}"; rename it`);
            }
            if (toolNames.has(action)) {
                throw new Error(`${aWhere}: collides with the tool "${action}"; rename it`);
            }
            validateActionCommand(aWhere, spec[action]);
        }
    }
}

function validateActionCommand(where: string, value: ActionSpec | undefined): void {
    const command =
        typeof value === "string" || Array.isArray(value) ? value : value?.command;
    if (typeof command === "string") {
        if (command.trim() === "") {
            throw new Error(`${where}: command must not be empty`);
        }
        return;
    }
    if (Array.isArray(command)) {
        if (command.length === 0 || command.some(item => typeof item !== "string")) {
            throw new Error(`${where}: command argv must be a non-empty array of strings`);
        }
        return;
    }
    throw new Error(`${where}: command must be a string, an argv array, or { command, cwd }`);
}

// Variable names share the character class that wiring templates accept for the
// `{<repo>.<key>}` form, so an allocated value is always referenceable.
const VARIABLE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function validateVariables(
    label: string,
    variables: Record<string, VariableSpec> | undefined,
): void {
    if (!variables) {
        return;
    }
    for (const [varName, spec] of Object.entries(variables)) {
        const where = `${label} variable "${varName}"`;
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
    // depends_on may cross the repo/app boundary in either direction, so the
    // known set and the cycle check span every member.
    const known = memberNames(cfg);
    const knownSet = new Set(known);
    const depsOf: Record<string, string[]> = {};
    for (const name of known) {
        const deps = memberConfig(cfg, name)?.depends_on;
        if (!deps) {
            continue;
        }
        for (const dep of deps) {
            if (!knownSet.has(dep)) {
                throw new Error(`Member "${name}" depends_on unknown member "${dep}"`);
            }
            if (dep === name) {
                throw new Error(`Member "${name}" depends_on itself`);
            }
        }
        depsOf[name] = deps;
    }
    const cycle = detectCycle(known, depsOf);
    if (cycle) {
        throw new Error(`depends_on cycle: ${cycle.join(" -> ")}`);
    }
}

// Repo keys `create` falls back to when `--include` is omitted. Validated here
// rather than inside `create` so a typo fails on every command, the same way an
// unknown `--include` key fails before any worktree work happens.
function validateDefaultInclude(cfg: MultreeConfig): void {
    if (cfg.default_include === undefined) {
        return;
    }
    if (!Array.isArray(cfg.default_include) || cfg.default_include.length === 0) {
        throw new Error("default_include must be a non-empty list of member keys");
    }
    const seen = new Set<string>();
    for (const name of cfg.default_include) {
        if (typeof name !== "string" || name.trim() === "") {
            throw new Error("default_include entries must be non-empty member keys");
        }
        if (!memberConfig(cfg, name)) {
            throw new Error(
                `default_include lists unknown member "${name}". ` +
                    `Available: ${memberNames(cfg).join(", ")}`,
            );
        }
        if (seen.has(name)) {
            throw new Error(`default_include lists "${name}" more than once`);
        }
        seen.add(name);
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
