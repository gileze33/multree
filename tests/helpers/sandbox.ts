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
}

export interface SandboxOptions {
    repos: FakeRepoSpec[];
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
}

const TRACE_VAR = "MULTREE_TEST_LOG";

function git(cwd: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}

function initFakeRepo(repoDir: string, spec: FakeRepoSpec): void {
    mkdirSync(repoDir, { recursive: true });
    if (spec.files) {
        for (const [rel, content] of Object.entries(spec.files)) {
            const full = join(repoDir, rel);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
        }
    }
    git(repoDir, "init -q -b develop");
    git(repoDir, `-c user.email=t@t -c user.name=t add -A`);
    git(repoDir, `-c user.email=t@t -c user.name=t commit -q --allow-empty -m initial`);
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
        initFakeRepo(repoDir, spec);

        const hooks: NonNullable<MultreeConfig["repos"][string]["hooks"]> = {};
        if (spec.install) hooks.install = spec.install;
        if (spec.setup) hooks.setup = spec.setup;
        if (spec.teardown) hooks.teardown = spec.teardown;

        repos[spec.key] = {
            path: repoDir,
            branch_base: "develop",
            hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
            exposes: spec.exposes,
            consumes: spec.consumes,
            defaults: spec.defaults,
        };
    }

    const config: MultreeConfig = {
        version: 1,
        worktree_root: worktreeRoot,
        repos,
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
            if (!existsSync(p)) return null;
            return JSON.parse(readFileSync(p, "utf-8")) as GroupState;
        },
        repoPath(key: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) throw new Error(`Unknown repo in sandbox: ${key}`);
            return join(reposRoot, spec.dirname ?? spec.key);
        },
        worktreePath(group: string, key: string) {
            const spec = opts.repos.find(r => r.key === key);
            if (!spec) throw new Error(`Unknown repo in sandbox: ${key}`);
            return join(worktreeRoot, group, spec.dirname ?? spec.key);
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
