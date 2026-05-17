import { execSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type {
    ConsumeSpec,
    ExposeSpec,
    GroupState,
    HookSpec,
    MainCheckoutAction,
    MultreeConfig,
    PrimeArtifactSpec,
} from "../../src/types.ts";

export interface FakeRepoSpec {
    key: string;
    dirname?: string;
    install?: HookSpec;
    setup?: HookSpec;
    teardown?: HookSpec;
    files?: Record<string, string>;
    exposes?: Record<string, ExposeSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    defaults?: Record<string, string | number>;
    // Extra branches to create in the source repo before any worktree work.
    // Each branch is forked from the repo's default branch and gets an extra
    // commit so it's distinguishable in ahead/behind output.
    branches?: string[];
    // If true, a bare repo is created under <reposRoot>/<dirname>.git and
    // registered as `origin` on the source repo. The initial commit (and any
    // extra branches) are pushed up so remote-tracking refs exist.
    withRemote?: boolean;
    // Repo manifest overrides.
    push?: boolean;
    updateStrategy?: "rebase" | "merge";
    mainCheckoutAction?: MainCheckoutAction;
    dependsOn?: string[];
    // Branch used for `git init -b`. Defaults to "develop". Set to "main"
    // (etc.) to exercise the default branch_base fallback.
    defaultBranch?: string;
    // Per-repo branch_base override. Defaults to whatever defaultBranch
    // resolves to. Pass `null` to omit branch_base from the manifest entirely
    // so resolveBranchBase falls back to its built-in "origin/main".
    branchBase?: string | null;
    // Per-repo hook timeout (string or seconds).
    hookTimeout?: string | number;
    // Artifacts to prime into each worktree before install runs.
    primeArtifacts?: PrimeArtifactSpec[];
}

export interface SandboxOptions {
    repos: FakeRepoSpec[];
    // Manifest-level config knobs. Useful for asserting that the
    // top-level defaults flow through when no per-repo override is set.
    updateStrategy?: "rebase" | "merge";
    mainCheckoutAction?: MainCheckoutAction;
    jobs?: number;
    parallelSetup?: boolean;
    hookTimeout?: string | number;
}

export interface Sandbox {
    root: string;
    reposRoot: string;
    worktreeRoot: string;
    manifestPath: string;
    traceLog: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
    trace: () => string[];
    state: (group: string) => GroupState | null;
    repoPath: (key: string) => string;
    worktreePath: (group: string, key: string) => string;
    // Add a commit on `develop` in the named source repo. Useful for tests
    // that need the base branch to be ahead of the worktree.
    advanceDevelop: (key: string, marker?: string) => void;
    // Run a git command in the source repo (under `develop` by default).
    gitInRepo: (key: string, cmd: string) => string;
    // Read a file from the bare remote (only valid for repos created with
    // withRemote: true). Returns null if the file isn't present on origin.
    remoteHasBranch: (key: string, branch: string) => boolean;
}

const TRACE_VAR = "MULTREE_TEST_LOG";

function git(cwd: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}

function gitOut(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function initFakeRepo(repoDir: string, spec: FakeRepoSpec, reposRoot: string): void {
    const defaultBranch = spec.defaultBranch ?? "develop";
    mkdirSync(repoDir, { recursive: true });
    if (spec.files) {
        for (const [rel, content] of Object.entries(spec.files)) {
            const full = join(repoDir, rel);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
        }
    }
    git(repoDir, `init -q -b ${defaultBranch}`);
    // Local config: identity + disable signing so sandbox repos don't try to
    // contact any system-level signing program.
    git(repoDir, "config user.email t@t");
    git(repoDir, "config user.name t");
    git(repoDir, "config commit.gpgsign false");
    git(repoDir, "config tag.gpgsign false");
    git(repoDir, "add -A");
    git(repoDir, "commit -q --allow-empty -m initial");

    if (spec.branches && spec.branches.length > 0) {
        for (const branch of spec.branches) {
            // Create branch from the default with one extra commit so it's
            // distinguishable in ahead/behind output.
            git(repoDir, `checkout -q -b "${branch}" ${defaultBranch}`);
            writeFileSync(join(repoDir, `${branch}.marker`), `${branch}\n`);
            git(repoDir, "add -A");
            git(repoDir, `commit -q -m "seed ${branch}"`);
        }
        git(repoDir, `checkout -q ${defaultBranch}`);
    }

    if (spec.withRemote) {
        const remoteDir = join(reposRoot, `${spec.dirname ?? spec.key}.git`);
        execSync(`git init -q --bare "${remoteDir}"`, { stdio: "pipe" });
        git(repoDir, `remote add origin "${remoteDir}"`);
        git(repoDir, `push -q origin ${defaultBranch}`);
        for (const branch of spec.branches ?? []) {
            git(repoDir, `push -q origin "${branch}"`);
        }
        // Mirror remote-tracking refs so branchExists/remoteBranchExists work.
        git(repoDir, "fetch -q origin");
    }
}

function buildRepoMap(specs: FakeRepoSpec[], reposRoot: string): MultreeConfig["repos"] {
    const repos: MultreeConfig["repos"] = {};
    for (const spec of specs) {
        const dirname = spec.dirname ?? spec.key;
        const repoDir = join(reposRoot, dirname);
        initFakeRepo(repoDir, spec, reposRoot);

        const hooks: NonNullable<MultreeConfig["repos"][string]["hooks"]> = {};
        if (spec.install) {
            hooks.install = spec.install;
        }
        if (spec.setup) {
            hooks.setup = spec.setup;
        }
        if (spec.teardown) {
            hooks.teardown = spec.teardown;
        }
        if (spec.hookTimeout !== undefined) {
            hooks.timeout = spec.hookTimeout;
        }

        const defaultBranch = spec.defaultBranch ?? "develop";
        repos[spec.key] = {
            path: repoDir,
            branch_base: spec.branchBase === null
                ? undefined
                : (spec.branchBase ?? defaultBranch),
            hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
            exposes: spec.exposes,
            consumes: spec.consumes,
            defaults: spec.defaults,
            push: spec.push,
            update_strategy: spec.updateStrategy,
            main_checkout_action: spec.mainCheckoutAction,
            depends_on: spec.dependsOn,
            prime_artifacts: spec.primeArtifacts,
        };
    }
    return repos;
}

export function createSandbox(opts: SandboxOptions): Sandbox {
    const root = mkdtempSync(join(tmpdir(), "multree-sandbox-"));
    const home = join(root, "home");
    const reposRoot = join(root, "repos");
    const worktreeRoot = join(root, "worktree");
    mkdirSync(home, { recursive: true });
    mkdirSync(reposRoot, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });

    const traceLog = join(root, "trace.log");
    writeFileSync(traceLog, "");

    const repos = buildRepoMap(opts.repos, reposRoot);

    const config: MultreeConfig = {
        version: 1,
        worktree_root: worktreeRoot,
        repos,
        update_strategy: opts.updateStrategy,
        main_checkout_action: opts.mainCheckoutAction,
        jobs: opts.jobs,
        parallel_setup: opts.parallelSetup,
        hook_timeout: opts.hookTimeout,
    };

    const manifestPath = join(home, "default.yaml");
    writeFileSync(manifestPath, stringify(config));

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MULTREE_HOME: home,
        [TRACE_VAR]: traceLog,
    };
    delete env.MULTREE_CONFIG;
    delete env.MULTREE_PROFILE;

    return {
        root,
        reposRoot,
        worktreeRoot,
        manifestPath,
        traceLog,
        env,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
        trace() {
            return readFileSync(traceLog, "utf-8").split("\n").filter(Boolean);
        },
        state(group: string) {
            const p = join(worktreeRoot, group, ".multree.json");
            if (!existsSync(p)) {
                return null;
            }
            return JSON.parse(readFileSync(p, "utf-8")) as GroupState;
        },
        repoPath(key: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) {
                throw new Error(`Unknown repo in sandbox: ${key}`);
            }
            return join(reposRoot, spec.dirname ?? spec.key);
        },
        worktreePath(group: string, key: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) {
                throw new Error(`Unknown repo in sandbox: ${key}`);
            }
            return join(worktreeRoot, group, spec.dirname ?? spec.key);
        },
        advanceDevelop(key: string, marker?: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) {
                throw new Error(`Unknown repo in sandbox: ${key}`);
            }
            const repoDir = join(reposRoot, spec.dirname ?? spec.key);
            const tag = marker ?? `advance-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
            const file = `develop-${tag}.txt`;
            writeFileSync(join(repoDir, file), `${tag}\n`);
            git(repoDir, "add -A");
            git(repoDir, `commit -q -m "advance ${tag}"`);
            if (spec.withRemote) {
                git(repoDir, "push -q origin develop");
            }
        },
        gitInRepo(key: string, cmd: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) {
                throw new Error(`Unknown repo in sandbox: ${key}`);
            }
            return gitOut(join(reposRoot, spec.dirname ?? spec.key), cmd);
        },
        remoteHasBranch(key: string, branch: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec || !spec.withRemote) {
                return false;
            }
            const remoteDir = join(reposRoot, `${spec.dirname ?? spec.key}.git`);
            try {
                execSync(`git show-ref --verify --quiet "refs/heads/${branch}"`, {
                    cwd: remoteDir,
                    stdio: "ignore",
                });
                return true;
            } catch {
                return false;
            }
        },
    };
}

// --- Multi-profile sandbox -------------------------------------------------
//
// A single MULTREE_HOME shared across N profiles, each with its own repos and
// worktree_root. Used to assert that profiles selected via --profile /
// $MULTREE_PROFILE / aliases.json stay fully isolated on disk and in state.

export interface MultiProfileSandboxOptions {
    profiles: Record<string, SandboxOptions>;
    aliases?: Record<string, string>;
}

export interface ProfileHandle {
    name: string;
    manifestPath: string;
    worktreeRoot: string;
    reposRoot: string;
    state: (group: string) => GroupState | null;
    repoPath: (key: string) => string;
    worktreePath: (group: string, key: string) => string;
}

export interface MultiProfileSandbox {
    root: string;
    home: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
    profile: (name: string) => ProfileHandle;
    writeAliases: (aliases: Record<string, string>) => void;
}

export function createMultiProfileSandbox(opts: MultiProfileSandboxOptions): MultiProfileSandbox {
    const root = mkdtempSync(join(tmpdir(), "multree-sandbox-multi-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const handles: Record<string, ProfileHandle> = {};
    const profileSpecs: Record<string, SandboxOptions> = {};

    for (const [name, profileOpts] of Object.entries(opts.profiles)) {
        // Per-profile reposRoot + worktreeRoot keep on-disk state strictly
        // partitioned: same group name in two profiles cannot collide.
        const reposRoot = join(root, `repos-${name}`);
        const worktreeRoot = join(root, `worktree-${name}`);
        mkdirSync(reposRoot, { recursive: true });
        mkdirSync(worktreeRoot, { recursive: true });

        const repos = buildRepoMap(profileOpts.repos, reposRoot);
        const config: MultreeConfig = {
            version: 1,
            worktree_root: worktreeRoot,
            repos,
            update_strategy: profileOpts.updateStrategy,
            main_checkout_action: profileOpts.mainCheckoutAction,
            jobs: profileOpts.jobs,
            parallel_setup: profileOpts.parallelSetup,
            hook_timeout: profileOpts.hookTimeout,
        };
        const manifestPath = join(home, `${name}.yaml`);
        writeFileSync(manifestPath, stringify(config));
        profileSpecs[name] = profileOpts;

        handles[name] = {
            name,
            manifestPath,
            worktreeRoot,
            reposRoot,
            state(group: string) {
                const p = join(worktreeRoot, group, ".multree.json");
                if (!existsSync(p)) {
                    return null;
                }
                return JSON.parse(readFileSync(p, "utf-8")) as GroupState;
            },
            repoPath(key: string) {
                const spec = profileOpts.repos.find(r => r.key === key);
                if (!spec) {
                    throw new Error(`Unknown repo in profile ${name}: ${key}`);
                }
                return join(reposRoot, spec.dirname ?? spec.key);
            },
            worktreePath(group: string, key: string) {
                const spec = profileOpts.repos.find(r => r.key === key);
                if (!spec) {
                    throw new Error(`Unknown repo in profile ${name}: ${key}`);
                }
                return join(worktreeRoot, group, spec.dirname ?? spec.key);
            },
        };
    }

    const writeAliasesFile = (aliases: Record<string, string>) => {
        const ordered: Record<string, string> = {};
        for (const k of Object.keys(aliases).sort()) {
            ordered[k] = aliases[k];
        }
        writeFileSync(join(home, "aliases.json"), JSON.stringify(ordered, null, 2) + "\n");
    };
    if (opts.aliases) {
        writeAliasesFile(opts.aliases);
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MULTREE_HOME: home,
    };
    delete env.MULTREE_CONFIG;
    delete env.MULTREE_PROFILE;

    void profileSpecs;
    return {
        root,
        home,
        env,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
        profile(name: string) {
            const h = handles[name];
            if (!h) {
                throw new Error(`Unknown profile in sandbox: ${name}`);
            }
            return h;
        },
        writeAliases: writeAliasesFile,
    };
}

// Hook command helper: append a line to the trace log, then run an optional
// follow-up snippet. Useful for asserting on exact hook invocation order.
export function trace(label: string, then?: string): string {
    const append = `echo "${label}" >> "$${TRACE_VAR}"`;
    return then ? `${append} && ${then}` : append;
}

// Same but exits non-zero after tracing — for simulating setup failures.
export function traceThenFail(label: string, then?: string): string {
    const append = `echo "${label}" >> "$${TRACE_VAR}"`;
    const tail = then ? `${then} && exit 1` : "exit 1";
    return `${append} && ${tail}`;
}
