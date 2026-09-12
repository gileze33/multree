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

// A single MCP server contributed by a member (repo or app) to the merged
// group-root `.mcp.json` under `mcpServers`. `type` (and, for http, `url`) are
// the meaningful fields; any extra keys (e.g. `headers`) are preserved verbatim
// into the JSON. String values may carry `{member.key}` wiring tokens, resolved
// when the group is wired.
export interface McpServerSpec {
    type: string;
    url?: string;
    [key: string]: unknown;
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
    // MCP servers this repo contributes to the group-root `.mcp.json` (merged
    // with every other member's `mcps`; see McpServerSpec and json.ts).
    mcps?: Record<string, McpServerSpec>;
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

// An `app` is a group member with no source tree: a sidecar process (a mail
// sink, a mock service, a tunnel) run from a published binary rather than
// checked out and developed. It participates in the variables / consumes /
// mcps wiring like a repo, but is backed by a per-group
// scratchpad directory (<worktree_root>/<group>/<app-name>/) instead of a git
// worktree, and is launched from `run` (with `env` injected) rather than
// prime/install/build hooks.
export interface AppConfig {
    variables?: Record<string, VariableSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    mcps?: Record<string, McpServerSpec>;
    defaults?: Record<string, string | number>;
    // Templated env injected into the process when the app runs. Unlike a repo's
    // file-based `consumes`, multree launches the process itself, so it sets
    // these directly in the child environment — no dotfile is written.
    env?: Record<string, string>;
    // The app's primary command, dispatched as `multree run <group> <app>`.
    run?: string | string[];
    // Optional extra verbs on the app target; each is `multree <verb> <group>
    // <app>`. The reserved verb `run` comes from `run` above.
    commands?: Record<string, ActionSpec>;
    depends_on?: string[];
}

// The shared shape the wiring / variables machinery reads: repos and apps are
// both "members". Only fields present on both kinds are reachable through the
// union (variables/consumes/defaults/mcps/commands/depends_on); `exposes` and
// `hooks` are repo-only.
export type MemberConfig = RepoConfig | AppConfig;

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

// A pane kind in the cmux workspace layout. "service" runs each of a repo's
// `run` command targets in its own pane; "shell" opens a plain shell in the
// repo's worktree; "skip" gives the repo no pane.
export type CmuxPaneKind = "service" | "shell" | "skip";

export interface CmuxConfig {
    // When `multree create` opens a cmux workspace. Unset (default): open when a
    // `cmux` block is present AND multree is running inside cmux. `true`/`false`
    // force it on/off regardless. The `--cmux` / `--no-cmux` flags on `create`
    // override this per invocation.
    auto?: boolean;
    // Width fraction (strictly between 0 and 1) the left Claude pane gets; the
    // service/shell stack on the right takes the remainder. Default 0.5.
    split?: number;
    // Command for the left pane. Shell string or argv array. Defaults to the
    // `claude` tool's command if one is defined, else "claude".
    claude?: string | string[];
    // Which cmux sidebar group to open the workspace into. Unset or "current":
    // the group the `multree` command was run from (ungrouped if the caller is
    // not in one). "none": always ungrouped. Any other value: upsert a group of
    // that name and open within it. `--group <name|current>` / `--no-group`
    // override per invocation.
    group?: string;
    // Per-repo pane override, keyed by repo key. A single kind or a list (e.g.
    // ["service", "shell"] for a dev server plus a worktree shell). Default per
    // repo: "service" if it declares `run` targets, else "shell".
    panes?: Record<string, CmuxPaneKind | CmuxPaneKind[]>;
}

// Opt-in conveniences for a `multree claude <group>` session opened at the group
// root. Both default off (block absent = no change). Neither touches workspace
// trust or MCP approval state (~/.claude.json); they only make servers and files
// discoverable, which still requires the folder to be trusted to take effect.
export interface ClaudeWorkspaceConfig {
    // Fold each repo member's own checked-in `.mcp.json` servers into the merged
    // group-root `.mcp.json`. Claude only discovers `.mcp.json` at the launch dir
    // (plus user/managed scopes), never in subdirectories, so without this a
    // sub-repo's servers are invisible from the group root.
    hoist_member_mcps?: boolean;
    // Write a group-root `.claude/settings.json` whose
    // `permissions.additionalDirectories` lists each repo member's worktree.
    // Inherited folder-trust excludes nested git repos, so this grants the
    // session file access to the sibling repo worktrees (it does NOT load their
    // `.mcp.json` — that is what hoist_member_mcps is for).
    additional_directories?: boolean;
}

export interface MultreeConfig {
    version: 1;
    worktree_root?: string;
    repos: Record<string, RepoConfig>;
    // Non-repo process members (sidecars). See AppConfig. Optional.
    apps?: Record<string, AppConfig>;
    // Opt-in group-root conveniences for `multree claude`. See ClaudeWorkspaceConfig.
    claude_workspace?: ClaudeWorkspaceConfig;
    tools?: Record<string, ToolConfig>;
    // Optional cmux integration. Its presence (inside cmux) is the opt-in; see
    // CmuxConfig. Absent = multree never touches cmux.
    cmux?: CmuxConfig;
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
    // Repo keys `create` uses when no `--include` is given. `--include` always
    // wins. Keys are validated against `repos` at config load, so a typo fails
    // on every command rather than mid-create.
    default_include?: string[];
}

export type PhaseName = "prime" | "install" | "setup";
export type PhaseStatus = "done" | "failed";

export interface MemberState {
    repo: string;
    // "app" for a non-repo process member (a scratchpad dir, no git); absent or
    // "repo" for a git-worktree member. Lets create/destroy/status/list skip git
    // for apps.
    kind?: "repo" | "app";
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
    // Server names multree owns in the group-root `.mcp.json` (contributed by
    // members' `mcps` blocks). Tracked so rewire updates them in place and
    // remove/destroy delete only what multree wrote, preserving hand-added keys.
    mcp_servers?: string[];
    // Absolute directories multree added to the group-root
    // `.claude/settings.json` `permissions.additionalDirectories`. Tracked so
    // rewire syncs the set and foreign (user-added) entries are preserved.
    additional_directories?: string[];
    // The cmux workspace opened for this group, if any. Stored as a stable
    // workspace UUID so teardown works from a later session. Set by `create`
    // (when cmux is enabled) or `multree cmux up`; cleared by `multree cmux down`.
    cmux?: { workspace_id: string };
}
