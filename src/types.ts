export interface HookCmd {
    command: string;
    cwd?: "worktree" | "repo";
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

export type PrimeStrategy = "copy" | "reflink";

export interface PrimeArtifactSpec {
    // Exactly one of these:
    path?: string; // a single relative path (file or directory)
    find?: string; // basename to find recursively under the repo (e.g. "node_modules")
    strategy?: PrimeStrategy; // default: "copy"
}

export type UpdateStrategy = "rebase" | "merge";

export interface RepoConfig {
    path: string;
    branch_base?: string;
    hooks?: {
        // Phases run in order: install -> setup. Both optional.
        // install runs after `prime_artifacts` has populated the worktree.
        install?: HookSpec;
        setup?: HookSpec;
        teardown?: HookSpec;
    };
    exposes?: Record<string, ExposeSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    defaults?: Record<string, string | number>;
    prime_artifacts?: PrimeArtifactSpec[];
    // Strategy used by `multree update`. Falls back to manifest-level
    // `update_strategy`, then to "merge".
    update_strategy?: UpdateStrategy;
    // Set false to skip this repo in `multree push` (read-only mirrors etc.).
    // Defaults to true.
    push?: boolean;
}

export interface ToolConfig {
    // Shell string ("code {cwd}") or argv array (["code", "{cwd}"]).
    command: string | string[];
    // Where to launch the tool. A chain of preferences -- first non-null wins.
    // Items: "$root" -> group dir, otherwise a repo key (e.g. "api").
    open_in?: string | string[];
}

export interface MultreeConfig {
    version: 1;
    worktree_root?: string;
    repos: Record<string, RepoConfig>;
    tools?: Record<string, ToolConfig>;
    // Manifest-level default for `multree update`. Per-repo `update_strategy`
    // overrides this. If neither is set, "merge" wins.
    update_strategy?: UpdateStrategy;
}

export interface MemberState {
    repo: string;
    path: string;
    // Branch this member's worktree is on. Older state files predate this
    // field; consumers fall back to GroupState.branch when it's absent.
    branch?: string;
    exposes: Record<string, string>;
}

export interface GroupState {
    name: string;
    branch: string;
    created_at: string;
    members: Record<string, MemberState>;
}
