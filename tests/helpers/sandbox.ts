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

// Rich per-profile handle. Returned by `createMultiProfileSandbox().profile(name)`
// and also flattened onto the top-level `Sandbox` for the single-profile case.
export interface ProfileHandle {
    name: string;
    manifestPath: string;
    reposRoot: string;
    worktreeRoot: string;
    state: (group: string) => GroupState | null;
    repoPath: (key: string) => string;
    worktreePath: (group: string, key: string) => string;
    // Add a commit on `develop` in the named source repo. Useful for tests
    // that need the base branch to be ahead of the worktree.
    advanceDevelop: (key: string, marker?: string) => void;
    // Run a git command in the source repo (under `develop` by default).
    gitInRepo: (key: string, cmd: string) => string;
    // True iff this profile's source repo (with `withRemote: true`) has the
    // given branch in its bare remote.
    remoteHasBranch: (key: string, branch: string) => boolean;
}

export interface Sandbox extends Omit<ProfileHandle, "name"> {
    root: string;
    traceLog: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
    trace: () => string[];
}

export interface MultiProfileSandboxOptions {
    profiles: Record<string, SandboxOptions>;
    aliases?: Record<string, string>;
}

export interface MultiProfileSandbox {
    root: string;
    home: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
    profile: (name: string) => ProfileHandle;
    writeAliases: (aliases: Record<string, string>) => void;
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

interface SandboxRoot {
    root: string;
    home: string;
    traceLog: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
}

// Tmpdir + MULTREE_HOME + trace log + env. Shared scaffold for both the single-
// and multi-profile public entrypoints. Everything sandbox-wide that isn't
// per-profile lives here.
function createSandboxRoot(prefix: string): SandboxRoot {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const traceLog = join(root, "trace.log");
    writeFileSync(traceLog, "");
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MULTREE_HOME: home,
        [TRACE_VAR]: traceLog,
    };
    delete env.MULTREE_CONFIG;
    delete env.MULTREE_PROFILE;
    return {
        root,
        home,
        traceLog,
        env,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

// Build one profile yaml + its repo fixtures under `parent`. Returns the rich
// handle every test needs (state, repoPath, worktreePath, advanceDevelop,
// gitInRepo, remoteHasBranch). Single- and multi-profile sandboxes both call
// this for each profile they own.
function createProfileFixture(
    parent: string,
    home: string,
    name: string,
    opts: SandboxOptions,
): ProfileHandle {
    const reposRoot = join(parent, `repos-${name}`);
    const worktreeRoot = join(parent, `worktree-${name}`);
    mkdirSync(reposRoot, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });

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
    const manifestPath = join(home, `${name}.yaml`);
    writeFileSync(manifestPath, stringify(config));

    const findSpec = (key: string): FakeRepoSpec => {
        const spec = opts.repos.find(r => r.key === key);
        if (!spec) {
            throw new Error(`Unknown repo in profile ${name}: ${key}`);
        }
        return spec;
    };
    const dirFor = (key: string): string => join(reposRoot, findSpec(key).dirname ?? key);

    return {
        name,
        manifestPath,
        reposRoot,
        worktreeRoot,
        state(group: string) {
            const p = join(worktreeRoot, group, ".multree.json");
            if (!existsSync(p)) {
                return null;
            }
            return JSON.parse(readFileSync(p, "utf-8")) as GroupState;
        },
        repoPath(key: string) {
            return dirFor(key);
        },
        worktreePath(group: string, key: string) {
            return join(worktreeRoot, group, findSpec(key).dirname ?? key);
        },
        advanceDevelop(key: string, marker?: string) {
            const spec = findSpec(key);
            const repoDir = dirFor(key);
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
            return gitOut(dirFor(key), cmd);
        },
        remoteHasBranch(key: string, branch: string) {
            const spec = findSpec(key);
            if (!spec.withRemote) {
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

function writeAliasesJson(home: string, aliases: Record<string, string>): void {
    const ordered: Record<string, string> = {};
    for (const k of Object.keys(aliases).sort()) {
        ordered[k] = aliases[k];
    }
    writeFileSync(join(home, "aliases.json"), JSON.stringify(ordered, null, 2) + "\n");
}

export function createSandbox(opts: SandboxOptions): Sandbox {
    const r = createSandboxRoot("multree-sandbox-");
    const profile = createProfileFixture(r.root, r.home, "default", opts);
    return {
        root: r.root,
        traceLog: r.traceLog,
        env: r.env,
        cleanup: r.cleanup,
        trace() {
            return readFileSync(r.traceLog, "utf-8").split("\n").filter(Boolean);
        },
        manifestPath: profile.manifestPath,
        reposRoot: profile.reposRoot,
        worktreeRoot: profile.worktreeRoot,
        state: profile.state,
        repoPath: profile.repoPath,
        worktreePath: profile.worktreePath,
        advanceDevelop: profile.advanceDevelop,
        gitInRepo: profile.gitInRepo,
        remoteHasBranch: profile.remoteHasBranch,
    };
}

export function createMultiProfileSandbox(opts: MultiProfileSandboxOptions): MultiProfileSandbox {
    const r = createSandboxRoot("multree-sandbox-multi-");
    const handles: Record<string, ProfileHandle> = {};
    for (const [name, profileOpts] of Object.entries(opts.profiles)) {
        handles[name] = createProfileFixture(r.root, r.home, name, profileOpts);
    }
    if (opts.aliases) {
        writeAliasesJson(r.home, opts.aliases);
    }
    return {
        root: r.root,
        home: r.home,
        env: r.env,
        cleanup: r.cleanup,
        profile(name: string) {
            const h = handles[name];
            if (!h) {
                throw new Error(`Unknown profile in sandbox: ${name}`);
            }
            return h;
        },
        writeAliases(aliases: Record<string, string>) {
            writeAliasesJson(r.home, aliases);
        },
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
