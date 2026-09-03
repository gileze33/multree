import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, resolve } from "path";
import { parse } from "yaml";
import { SUBCOMMANDS } from "./completion.ts";
import { detectCycle } from "./scheduler.ts";
import type {
    ActionSpec,
    MainCheckoutAction,
    MultreeConfig,
    PrimeArtifactSpec,
    PrimeStrategy,
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

export interface LoadOptions extends ResolveOptions {
    // Commands that only inspect or tear down a group that already exists never
    // run the prime phase, so a priming-validation failure must not lock the
    // user out of the very commands they need to look at and clean up that
    // group. Those commands pass true; everything else fails at load.
    tolerateInvalidPrimeArtifacts?: boolean;
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
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
    validate(config, opts.tolerateInvalidPrimeArtifacts === true);
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

function validate(cfg: MultreeConfig, tolerateInvalidPrimeArtifacts: boolean): void {
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
        validateCommands(name, repo, cfg);
    }
    validateDependsOn(cfg);
    validateDefaultInclude(cfg);
    try {
        validatePrimeArtifacts(cfg);
    } catch (err) {
        if (!tolerateInvalidPrimeArtifacts) {
            throw err;
        }
        console.warn(
            `! ${err instanceof Error ? err.message : String(err)}\n` +
                `  Continuing: this command does not prime artifacts. Fix the manifest ` +
                `before creating a group or adding a member.`,
        );
    }
}

const PRIME_STRATEGIES: readonly PrimeStrategy[] = ["copy", "reflink", "symlink"];

// Structural and collision checks for both priming tiers. These run at load,
// not when the prime phase runs: a manifest-level entry is read by every repo,
// so a malformed one would otherwise fail every member's prime after the
// worktrees already exist. artifacts.ts keeps its own throws as defence in
// depth for callers that build specs by hand.
function validatePrimeArtifacts(cfg: MultreeConfig): void {
    validatePrimeList("Manifest-level prime_artifacts", cfg.prime_artifacts);
    for (const [name, repo] of Object.entries(cfg.repos)) {
        validatePrimeList(`Repo "${name}" prime_artifacts`, repo.prime_artifacts);
    }
    // Collisions are checked against each repo's EFFECTIVE list, so an
    // inherited entry is caught for every repo that inherits it — the common
    // case, and the one a declared-only check would miss.
    for (const [name, repo] of Object.entries(cfg.repos)) {
        validatePrimeCollisions(cfg, name, repo);
    }
}

function validatePrimeList(where: string, specs: PrimeArtifactSpec[] | undefined): void {
    if (specs === undefined) {
        return;
    }
    if (!Array.isArray(specs)) {
        throw new Error(`${where}: must be a list of entries`);
    }
    const claimed = new Set<string>();
    for (const spec of specs) {
        const hasPath = spec.path !== undefined;
        const hasFind = spec.find !== undefined;
        if (hasPath && hasFind) {
            throw new Error(`${where}: specify either 'path' or 'find', not both`);
        }
        if (!hasPath && !hasFind) {
            throw new Error(`${where}: must specify 'path' or 'find'`);
        }
        const field = hasPath ? "path" : "find";
        const value = hasPath ? spec.path : spec.find;
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`${where}: ${field} must be a non-empty string`);
        }
        if (spec.strategy !== undefined && !PRIME_STRATEGIES.includes(spec.strategy)) {
            throw new Error(
                `${where}: unknown strategy "${spec.strategy}" ` +
                    `(expected ${PRIME_STRATEGIES.join(", ")})`,
            );
        }
        const key = `${field}:${value}`;
        if (claimed.has(key)) {
            throw new Error(`${where}: declares ${field} "${value}" more than once`);
        }
        claimed.add(key);
    }
}

// Env files this repo wires: multree writes consumes blocks into them and reads
// exposes out of them. A symlink over one writes through to the main checkout,
// which is the one priming collision multree can prove is wrong.
function wiredFiles(repoCfg: RepoConfig): { file: string; source: string }[] {
    const out: { file: string; source: string }[] = [];
    for (const spec of Object.values(repoCfg.exposes ?? {})) {
        if (typeof spec?.file === "string") {
            out.push({ file: spec.file, source: "exposes" });
        }
    }
    const consumes = repoCfg.consumes === undefined
        ? []
        : (Array.isArray(repoCfg.consumes) ? repoCfg.consumes : [repoCfg.consumes]);
    for (const spec of consumes) {
        if (typeof spec?.file === "string") {
            out.push({ file: spec.file, source: "consumes" });
        }
    }
    return out;
}

// Worktree-relative form for comparison. Trailing slashes and a leading "./"
// are noise; everything else is compared on segment boundaries so "conf" never
// matches "config/app.env".
function normalizeWorktreeRelative(p: string): string {
    const normalized = normalize(p).replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
}

function validatePrimeCollisions(
    cfg: MultreeConfig,
    repoName: string,
    repoCfg: RepoConfig,
): void {
    const wired = wiredFiles(repoCfg);
    if (wired.length === 0) {
        return;
    }
    const own = repoCfg.prime_artifacts ?? [];
    for (const spec of resolvePrimeArtifacts(cfg, repoCfg)) {
        // `find` matches can't be enumerated before the source repo is walked,
        // so a find-addressed entry is deliberately left unchecked.
        if (spec.strategy !== "symlink" || spec.path === undefined) {
            continue;
        }
        const link = normalizeWorktreeRelative(spec.path);
        for (const { file, source } of wired) {
            const target = normalizeWorktreeRelative(file);
            if (target !== link && !target.startsWith(`${link}/`)) {
                continue;
            }
            const where = own.includes(spec)
                ? `Repo "${repoName}" prime_artifacts`
                : `Manifest-level prime_artifacts (inherited by repo "${repoName}")`;
            throw new Error(
                `${where}: symlink entry "${spec.path}" covers the ${source} file ` +
                    `"${file}", so multree would write into repo "${repoName}"'s main ` +
                    `checkout. Use copy or reflink for that path, or move the entry.`,
            );
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

// Repo keys `create` falls back to when `--include` is omitted. Validated here
// rather than inside `create` so a typo fails on every command, the same way an
// unknown `--include` key fails before any worktree work happens.
function validateDefaultInclude(cfg: MultreeConfig): void {
    if (cfg.default_include === undefined) {
        return;
    }
    if (!Array.isArray(cfg.default_include) || cfg.default_include.length === 0) {
        throw new Error("default_include must be a non-empty list of repo keys");
    }
    const seen = new Set<string>();
    for (const repo of cfg.default_include) {
        if (typeof repo !== "string" || repo.trim() === "") {
            throw new Error("default_include entries must be non-empty repo keys");
        }
        if (!cfg.repos[repo]) {
            throw new Error(
                `default_include lists unknown repo "${repo}". ` +
                    `Available: ${Object.keys(cfg.repos).join(", ")}`,
            );
        }
        if (seen.has(repo)) {
            throw new Error(`default_include lists "${repo}" more than once`);
        }
        seen.add(repo);
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

// Identity of the thing an entry primes. `path: x` and `find: x` are distinct
// targets — one is a literal location, the other a basename searched for
// anywhere in the tree — so the addressing field is part of the key. Returns
// undefined for a structurally invalid entry (neither field, or both), which
// validatePrimeArtifacts rejects at load; such an entry is never deduped.
function primeTargetKey(spec: PrimeArtifactSpec): string | undefined {
    if (spec.path !== undefined && spec.find !== undefined) {
        return undefined;
    }
    if (spec.path !== undefined) {
        return `path:${spec.path}`;
    }
    if (spec.find !== undefined) {
        return `find:${spec.find}`;
    }
    return undefined;
}

// A repo's effective priming list: its own entries EXTEND the manifest-level
// ones rather than replacing them. The repo's entries come first and a later
// entry for a target already claimed is dropped, so a repo overrides an
// inherited target's strategy just by naming that target — and, for a `path`
// and a `find` that happen to reach the same directory, its entry gets there
// first and the destination-occupied guard stops the inherited one.
//
// Both read sites (the prime phase and `create --plan`) must go through here;
// reading RepoConfig.prime_artifacts directly skips the inherited entries.
export function resolvePrimeArtifacts(
    cfg: MultreeConfig,
    repoCfg: RepoConfig,
): PrimeArtifactSpec[] {
    const out: PrimeArtifactSpec[] = [];
    const claimed = new Set<string>();
    for (const spec of [...(repoCfg.prime_artifacts ?? []), ...(cfg.prime_artifacts ?? [])]) {
        const key = primeTargetKey(spec);
        if (key !== undefined) {
            if (claimed.has(key)) {
                continue;
            }
            claimed.add(key);
        }
        out.push(spec);
    }
    return out;
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
