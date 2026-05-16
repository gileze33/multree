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
    MainCheckoutAction,
    MultreeConfig,
} from "../../src/types.ts";

export interface FakeRepoSpec {
    key: string;
    dirname?: string;
    install?: string;
    setup?: string;
    teardown?: string;
    files?: Record<string, string>;
    exposes?: Record<string, ExposeSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    defaults?: Record<string, string | number>;
    // Extra branches to create in the source repo before any worktree work.
    // Each branch is forked from `develop` and gets an extra commit so it's
    // distinguishable in ahead/behind output.
    branches?: string[];
    // If true, a bare repo is created under <reposRoot>/<dirname>.git and
    // registered as `origin` on the source repo. The initial commit (and any
    // extra branches) are pushed up so remote-tracking refs exist.
    withRemote?: boolean;
    // Repo manifest overrides.
    push?: boolean;
    updateStrategy?: "rebase" | "merge";
    mainCheckoutAction?: MainCheckoutAction;
}

export interface SandboxOptions {
    repos: FakeRepoSpec[];
    // Manifest-level config knobs. Useful for asserting that the
    // top-level defaults flow through when no per-repo override is set.
    updateStrategy?: "rebase" | "merge";
    mainCheckoutAction?: MainCheckoutAction;
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
    mkdirSync(repoDir, { recursive: true });
    if (spec.files) {
        for (const [rel, content] of Object.entries(spec.files)) {
            const full = join(repoDir, rel);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
        }
    }
    git(repoDir, "init -q -b develop");
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
            // Create branch from develop with one extra commit so it's
            // distinguishable in ahead/behind output.
            git(repoDir, `checkout -q -b "${branch}" develop`);
            writeFileSync(join(repoDir, `${branch}.marker`), `${branch}\n`);
            git(repoDir, "add -A");
            git(repoDir, `commit -q -m "seed ${branch}"`);
        }
        git(repoDir, "checkout -q develop");
    }

    if (spec.withRemote) {
        const remoteDir = join(reposRoot, `${spec.dirname ?? spec.key}.git`);
        execSync(`git init -q --bare "${remoteDir}"`, { stdio: "pipe" });
        git(repoDir, `remote add origin "${remoteDir}"`);
        git(repoDir, "push -q origin develop");
        for (const branch of spec.branches ?? []) {
            git(repoDir, `push -q origin "${branch}"`);
        }
        // Mirror remote-tracking refs so branchExists/remoteBranchExists work.
        git(repoDir, "fetch -q origin");
    }
}

export function createSandbox(opts: SandboxOptions): Sandbox {
    const root = mkdtempSync(join(tmpdir(), "multree-sandbox-"));
    const reposRoot = join(root, "repos");
    const worktreeRoot = join(root, "worktree");
    mkdirSync(reposRoot, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });

    const traceLog = join(root, "trace.log");
    writeFileSync(traceLog, "");

    const repos: MultreeConfig["repos"] = {};
    for (const spec of opts.repos) {
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

        repos[spec.key] = {
            path: repoDir,
            branch_base: "develop",
            hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
            exposes: spec.exposes,
            consumes: spec.consumes,
            defaults: spec.defaults,
            push: spec.push,
            update_strategy: spec.updateStrategy,
            main_checkout_action: spec.mainCheckoutAction,
        };
    }

    const config: MultreeConfig = {
        version: 1,
        worktree_root: worktreeRoot,
        repos,
        update_strategy: opts.updateStrategy,
        main_checkout_action: opts.mainCheckoutAction,
    };

    const manifestPath = join(root, "multree.config.yaml");
    writeFileSync(manifestPath, stringify(config));

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MULTREE_CONFIG: manifestPath,
        [TRACE_VAR]: traceLog,
    };

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
