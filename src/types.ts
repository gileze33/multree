export interface HookCmd {
    command: string;
    cwd?: "worktree" | "repo";
    // Per-hook timeout override. Accepts "30s", "5m", "2h", "500ms" or a bare
    // number (seconds). Falls back to RepoConfig.hooks.timeout, then to the
    // top-level `hook_timeout`. No timeout if all three are absent.
    timeout?: string | number;
}

// Hooks accept a bare string (defaults to cwd: worktree) or the full object form.
export type HookSpec = string | HookCmd;

export interface ExposeSpec {
    type: "env_file";
    file: string;
    key: string;
}

export interface ConsumeSpec {
    file: string;
    upsert: Record<string, string>;
}

// A repo-scoped variable that multree generates and allocates a value for when
// the repo joins a group. Allocated values are exposed automatically to the
// wiring context as `{<repo>.<name>}` (no `exposes` declaration needed), so
// any repo in the group — including the owner — can consume them.
//
// For now the only generation pattern is a number drawn from an inclusive
// [min, max] range. Allocation guarantees the value is not already in use by
// any other variable in any group across any profile (the ledger lives in
// $MULTREE_HOME/variables.json so the check spans profiles).
export interface NumberVariableSpec {
    // Optional; defaults to "number" (the only supported pattern today).
    type?: "number";
    min: number;
    max: number;
    // Fallback value used by consumers when the owning repo is NOT part of the
    // group (so `{<repo>.<name>}` still resolves). When the repo IS in the
    // group the allocated value wins and consumers are rewired to it. A
    // `defaults.<name>` map entry, if present, overrides this. Need not lie
    // within [min, max] — it can be a well-known shared port outside the
    // ephemeral allocation range.
    default?: number;
}

export type VariableSpec = NumberVariableSpec;

export type PrimeStrategy = "copy" | "reflink";

export interface PrimeArtifactSpec {
    // Exactly one of these:
    path?: string; // a single relative path (file or directory)
    find?: string; // basename to find recursively under the repo (e.g. "node_modules")
    strategy?: PrimeStrategy; // default: "copy"
}

export type UpdateStrategy = "rebase" | "merge";

// What to do when multree needs to check out a branch that's currently held
// by the source repo's MAIN checkout (i.e. not another multree worktree).
//   - "switch":  switch the main checkout to its branch_base (with any
//                `origin/` prefix stripped) before taking the branch.
//   - "detach":  detach the main checkout's HEAD on the current commit.
//   - "error":   refuse to act on the main checkout; surface an error.
// Default is "switch".
export type MainCheckoutAction = "switch" | "detach" | "error";

export interface RepoConfig {
    path: string;
    branch_base?: string;
    hooks?: {
        // Phases run in order: install -> setup. Both optional.
        // install runs after `prime_artifacts` has populated the worktree.
        install?: HookSpec;
        setup?: HookSpec;
        teardown?: HookSpec;
        // Default timeout for any phase of this repo, unless a per-hook
        // `timeout` overrides it. Accepts "5m", "30s", "500ms", or a number
        // (seconds).
        timeout?: string | number;
    };
    exposes?: Record<string, ExposeSpec>;
    // Variables multree generates and allocates for this repo on join. Exposed
    // automatically as `{<repo>.<name>}`, alongside any `exposes`/`defaults`.
    variables?: Record<string, VariableSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    defaults?: Record<string, string | number>;
    // Repo-scoped runnable commands. Each key is a target (e.g. a monorepo
    // package); each target maps action verbs to commands. See TargetSpec.
    commands?: Record<string, TargetSpec>;
    prime_artifacts?: PrimeArtifactSpec[];
    // Strategy used by `multree update`. Falls back to manifest-level
    // `update_strategy`, then to "rebase".
    update_strategy?: UpdateStrategy;
    // Set false to skip this repo in `multree push` (read-only mirrors etc.).
    // Defaults to true.
    push?: boolean;
    // Per-repo override of how to free a branch when the main checkout is
    // holding it. Falls back to manifest-level `main_checkout_action`, then
    // to "switch".
    main_checkout_action?: MainCheckoutAction;
    // Other repo keys whose `setup` must complete before this repo's `setup`
    // begins. Exposes from those repos are visible in this repo's setup
    // environment via the usual wiring. Cycles are rejected at validation.
    depends_on?: string[];
}

export interface ToolConfig {
    // Shell string ("code {cwd}") or argv array (["code", "{cwd}"]).
    command: string | string[];
    // Where to launch the tool. A chain of preferences -- first non-null wins.
    // Items: "$root" -> group dir, otherwise a repo key (e.g. "api").
    open_in?: string | string[];
}

// A single repo-scoped command. Mirrors ToolConfig.command (shell string or
// argv array) but lives under an action key inside a target. The object form
// adds a per-action `cwd` that overrides the target's `cwd`. `{cwd}` is
// substituted into the command, as for tools.
export type ActionSpec =
    | string
    | string[]
    | { command: string | string[]; cwd?: string };

// A runnable target inside a repo, e.g. a package in a monorepo. The reserved
// `cwd` key is the default subdirectory (relative to the worktree) every action
// runs in; any other key is an action verb whose value is the command to run.
// Dispatched as `multree <action> <group> <target>`. The shape mirrors `hooks`,
// which likewise mixes a reserved key (`timeout`) with named entries.
export interface TargetSpec {
    cwd?: string;
    [action: string]: ActionSpec | undefined;
}

export interface MultreeConfig {
    version: 1;
    worktree_root?: string;
    repos: Record<string, RepoConfig>;
    tools?: Record<string, ToolConfig>;
    // Manifest-level default for `multree update`. Per-repo `update_strategy`
    // overrides this. If neither is set, "rebase" wins.
    update_strategy?: UpdateStrategy;
    // Manifest-level default for what to do when a target branch is already
    // checked out in a repo's main source. Per-repo overrides win; if neither
    // is set, "switch" wins.
    main_checkout_action?: MainCheckoutAction;
    // Default concurrency cap for `create`'s prime/install (and setup when
    // parallel_setup is true). CLI `--jobs N` overrides. If neither is set,
    // os.cpus().length is used.
    jobs?: number;
    // Run the `setup` phase in parallel up to `jobs` (respecting depends_on).
    // Default false: setup runs serially because it often touches shared
    // resources (ports, databases).
    parallel_setup?: boolean;
    // Manifest-level default hook timeout. Overridden by RepoConfig.hooks.timeout
    // and individual HookCmd.timeout.
    hook_timeout?: string | number;
}

export type PhaseName = "prime" | "install" | "setup";
export type PhaseStatus = "done" | "failed";

export interface MemberState {
    repo: string;
    path: string;
    // Branch this member's worktree is on. Older state files predate this
    // field; consumers fall back to GroupState.branch when it's absent.
    branch?: string;
    exposes: Record<string, string>;
    // Values allocated for this member's declared `variables`. Persisted so
    // they stay stable across rewire/resume and so they can be released from
    // the global ledger on remove/destroy. Stored as strings to match the
    // wiring context (exposes/defaults are strings too).
    variables?: Record<string, string>;
    // Per-phase completion record. Populated as phases complete during
    // `create`. Used by `--resume` to skip phases that already succeeded.
    phase_status?: Partial<Record<PhaseName, PhaseStatus>>;
}

export interface GroupState {
    name: string;
    branch: string;
    created_at: string;
    members: Record<string, MemberState>;
}
