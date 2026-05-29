import { existsSync, mkdirSync } from "fs";
import { cpus } from "os";
import { basename, join } from "path";
import {
    executeMainCheckoutRelease,
    planMainCheckoutRelease,
    type MainCheckoutReleasePlan,
} from "../branch.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, branchExists, fetchRepo, remoteBranchExists } from "../git.ts";
import { HookFailureError, HookTimeoutError, normalizeHook } from "../hooks.ts";
import { runMemberPhase } from "../phases.ts";
import { runScheduled, topoOrder } from "../scheduler.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import type {
    GroupState,
    MultreeConfig,
    PhaseName,
    RepoConfig,
} from "../types.ts";
import { assignGroupVariables } from "../variables.ts";
import { wireGroup } from "../wiring.ts";

interface CreateArgs {
    name: string;
    include: string[];
    branch?: string;
    from?: string;
    branchesByRepo?: Record<string, string>;
    jobs?: number;
    plan?: boolean;
    resume?: boolean;
    verbose?: boolean;
}

interface MemberPlan {
    repoName: string;
    repoCfg: RepoConfig;
    repoPath: string;
    worktreePath: string;
    repoBranch: string;
    releasePlan?: MainCheckoutReleasePlan;
}

export async function createCommand(args: CreateArgs): Promise<void> {
    const { config, home, profile } = loadConfig();

    const existingGroup = loadGroup(config, args.name);
    if (existingGroup && !args.resume) {
        throw new Error(
            `Group "${args.name}" already exists. Destroy it first, use a different name, ` +
                `or pass --resume to continue from the last failed phase.`,
        );
    }
    if (!existingGroup && args.resume) {
        throw new Error(`--resume: no existing group named "${args.name}" to resume`);
    }

    for (const repo of args.include) {
        if (!config.repos[repo]) {
            throw new Error(
                `Unknown repo "${repo}". Available: ${Object.keys(config.repos).join(", ")}`,
            );
        }
    }
    for (const repo of Object.keys(args.branchesByRepo ?? {})) {
        if (!args.include.includes(repo)) {
            throw new Error(
                `--from-${repo} given but "${repo}" is not in --include`,
            );
        }
    }
    if (args.from && args.branch) {
        throw new Error("--from and --branch are mutually exclusive");
    }

    const defaultBranch = args.from ?? args.branch ?? existingGroup?.branch ?? `multree/${args.name}`;
    const dir = groupDir(config, args.name);
    if (!existingGroup && existsSync(dir)) {
        throw new Error(`Group directory already exists: ${dir}`);
    }

    const plans = preflight(config, args, defaultBranch, dir, existingGroup);
    const jobs = resolveJobCount(args.jobs, config.jobs);

    // --plan: print the plan and exit before any side effects.
    if (args.plan) {
        printPlan(args.name, defaultBranch, plans, config, jobs);
        return;
    }

    mkdirSync(dir, { recursive: true });

    const group: GroupState = existingGroup ?? {
        name: args.name,
        branch: defaultBranch,
        created_at: new Date().toISOString(),
        members: {},
    };
    saveGroup(config, group);

    // Phase 0: serial worktree creation. Cheap, and avoids racing git on the
    // same source repo. Members already on disk (from a prior failed run +
    // --resume) are skipped here.
    for (const plan of plans) {
        const { repoName, repoCfg, repoPath, worktreePath, repoBranch } = plan;
        if (group.members[repoName] && existsSync(worktreePath)) {
            continue;
        }
        if (plan.releasePlan) {
            executeMainCheckoutRelease(repoName, repoPath, repoBranch, plan.releasePlan);
        }
        console.log(`[${repoName}] creating worktree at ${worktreePath} (branch: ${repoBranch})`);
        addWorktree(repoPath, worktreePath, repoBranch, resolveBranchBase(repoCfg));
        group.members[repoName] = {
            repo: repoName,
            path: worktreePath,
            branch: repoBranch,
            exposes: {},
            phase_status: {},
        };
        saveGroup(config, group);
    }

    // Phases prime/install/setup. Each runs across all members; prime/install
    // are independent and bounded by `jobs`. Setup respects depends_on and
    // runs serially unless `parallel_setup` is set.
    await runPhase(config, group, plans, "prime", jobs, args.verbose ?? false);
    await runPhase(config, group, plans, "install", jobs, args.verbose ?? false);
    await runPhase(config, group, plans, "setup", jobs, args.verbose ?? false);

    console.log("");
    assignGroupVariables(home, profile, config, group);
    wireGroup(config, group);
    saveGroup(config, group);

    console.log(`\n✓ Group "${args.name}" created on branch "${defaultBranch}"`);
    console.log(`  Group dir: ${dir}`);
    for (const [repoName, member] of Object.entries(group.members)) {
        const tag = member.branch && member.branch !== defaultBranch ? ` (${member.branch})` : "";
        console.log(`  ${repoName}: ${member.path}${tag}`);
        for (const [k, v] of Object.entries(member.variables ?? {})) {
            console.log(`    variable ${k}=${v}`);
        }
        for (const [k, v] of Object.entries(member.exposes)) {
            console.log(`    exposed ${k}=${v}`);
        }
    }
}

function resolveJobCount(cliJobs: number | undefined, configJobs: number | undefined): number {
    if (cliJobs !== undefined) {
        return Math.max(1, cliJobs);
    }
    if (configJobs !== undefined) {
        return Math.max(1, configJobs);
    }
    return Math.max(1, cpus().length);
}

async function runPhase(
    config: MultreeConfig,
    group: GroupState,
    plans: MemberPlan[],
    phase: PhaseName,
    jobs: number,
    verbose: boolean,
): Promise<void> {
    const planByName = new Map(plans.map(p => [p.repoName, p]));
    const repoNames = plans.map(p => p.repoName);
    const phaseJobs = phase === "setup" && !config.parallel_setup ? 1 : jobs;
    const depsOf: Record<string, string[]> = {};
    if (phase === "setup") {
        for (const p of plans) {
            const deps = (p.repoCfg.depends_on ?? []).filter(d => repoNames.includes(d));
            if (deps.length > 0) {
                depsOf[p.repoName] = deps;
            }
        }
    }

    const work = async (repoName: string): Promise<void> => {
        const plan = planByName.get(repoName);
        if (!plan) {
            return;
        }
        const member = group.members[repoName];
        if (!member) {
            throw new Error(`internal: member ${repoName} missing from state`);
        }
        if (member.phase_status?.[phase] === "done") {
            console.log(`[${repoName}] ${phase}: skipped (already done)`);
            return;
        }
        try {
            await runMemberPhase(config, plan, member, phase, { verbose });
            recordPhase(group, repoName, phase, "done");
        } catch (err) {
            recordPhase(group, repoName, phase, "failed");
            throw err;
        } finally {
            saveGroup(config, group);
        }
    };

    const results = await runScheduled(repoNames, work, { jobs: phaseJobs, depsOf });
    const failures = results.filter(r => r.outcome === "failed");
    const skipped = results.filter(r => r.outcome === "skipped");
    if (failures.length === 0 && skipped.length === 0) {
        return;
    }
    const msg = [`${phase} phase failed:`];
    for (const f of failures) {
        msg.push(formatFailureLine(f.key, f.error));
    }
    for (const s of skipped) {
        msg.push(`  [${s.key}] skipped (dependency failed)`);
    }
    throw new Error(msg.join("\n"));
}

function formatFailureLine(repoName: string, err: Error | undefined): string {
    if (!err) {
        return `  [${repoName}] failed`;
    }
    if (err instanceof HookTimeoutError) {
        return `  [${repoName}] timed out after ${err.timeoutMs}ms`;
    }
    if (err instanceof HookFailureError) {
        return `  [${repoName}] ${err.message}`;
    }
    return `  [${repoName}] ${err.message}`;
}

function recordPhase(
    group: GroupState,
    repoName: string,
    phase: PhaseName,
    status: "done" | "failed",
): void {
    const member = group.members[repoName];
    if (!member) {
        return;
    }
    if (!member.phase_status) {
        member.phase_status = {};
    }
    member.phase_status[phase] = status;
}

function printPlan(
    name: string,
    branch: string,
    plans: MemberPlan[],
    config: MultreeConfig,
    jobs: number,
): void {
    console.log(`Plan for create "${name}" on branch "${branch}":`);
    console.log(`  jobs=${jobs}, parallel_setup=${config.parallel_setup ? "true" : "false"}`);
    console.log("");
    for (const p of plans) {
        console.log(`  [${p.repoName}] worktree -> ${p.worktreePath} (branch: ${p.repoBranch})`);
    }
    console.log("");
    console.log(`Phase prime (parallel up to ${jobs}):`);
    for (const p of plans) {
        const n = p.repoCfg.prime_artifacts?.length ?? 0;
        console.log(`  [${p.repoName}] ${n} artifact spec(s)`);
    }
    console.log("");
    console.log(`Phase install (parallel up to ${jobs}):`);
    for (const p of plans) {
        const hook = normalizeHook(p.repoCfg.hooks?.install);
        console.log(`  [${p.repoName}] ${hook ? hook.command : "(none)"}`);
    }
    console.log("");
    const setupJobs = config.parallel_setup ? jobs : 1;
    const repoNames = plans.map(p => p.repoName);
    const depsOf: Record<string, string[]> = {};
    for (const p of plans) {
        const deps = (p.repoCfg.depends_on ?? []).filter(d => repoNames.includes(d));
        if (deps.length > 0) {
            depsOf[p.repoName] = deps;
        }
    }
    const setupOrder = topoOrder(repoNames, depsOf);
    console.log(
        `Phase setup (${config.parallel_setup ? `parallel up to ${setupJobs}` : "serial"}, ` +
            `topo order from depends_on):`,
    );
    for (const repoName of setupOrder) {
        const p = plans.find(x => x.repoName === repoName);
        if (!p) {
            throw new Error(`internal: plan missing for ${repoName}`);
        }
        const hook = normalizeHook(p.repoCfg.hooks?.setup);
        const deps = depsOf[repoName] ? ` (after: ${depsOf[repoName].join(", ")})` : "";
        console.log(`  [${repoName}] ${hook ? hook.command : "(none)"}${deps}`);
    }
    console.log("");
    console.log("Then: wire env files.");
}

// Runs every check we can run without touching worktrees. Fetches each repo
// up-front (the network cost we'd pay anyway) so branch-existence checks see
// fresh remote-tracking refs. Throws a single aggregated error if any plan
// item is invalid; the main loop is only entered after every member passes.
function preflight(
    config: MultreeConfig,
    args: CreateArgs,
    defaultBranch: string,
    dir: string,
    existing: GroupState | null,
): MemberPlan[] {
    const plans: MemberPlan[] = [];
    const errors: string[] = [];

    for (const repoName of args.include) {
        const repoCfg = config.repos[repoName];
        const repoPath = expandPath(repoCfg.path);
        const worktreePath = join(dir, basename(repoPath));
        const repoBranch = args.branchesByRepo?.[repoName] ?? defaultBranch;

        console.log(`\n[${repoName}] git fetch`);
        fetchRepo(repoPath);

        const memberAlreadyExists = existing?.members[repoName] && existsSync(worktreePath);
        const fromBranchRequested = args.from !== undefined
            || args.branchesByRepo?.[repoName] !== undefined;
        const localExists = branchExists(repoPath, repoBranch);
        const remoteExists = remoteBranchExists(repoPath, "origin", repoBranch);

        if (fromBranchRequested && !localExists && !remoteExists) {
            errors.push(
                `[${repoName}] --from branch "${repoBranch}" not found locally or on origin in ${repoPath}`,
            );
            continue;
        }

        if (!memberAlreadyExists && existsSync(worktreePath)) {
            errors.push(`[${repoName}] worktree path already exists: ${worktreePath}`);
            continue;
        }

        let releasePlan: MainCheckoutReleasePlan | undefined;
        if (!memberAlreadyExists) {
            const release = planMainCheckoutRelease(config, repoCfg, repoName, repoPath, repoBranch);
            if (release.error) {
                errors.push(release.error);
                continue;
            }
            releasePlan = release.plan;
        }

        plans.push({
            repoName,
            repoCfg,
            repoPath,
            worktreePath,
            repoBranch,
            releasePlan,
        });
    }

    if (errors.length > 0) {
        throw new Error(
            `create aborted; ${errors.length} member${errors.length === 1 ? "" : "s"} failed pre-flight:\n  ` +
                errors.join("\n  "),
        );
    }
    return plans;
}
