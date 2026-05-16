import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { primeArtifacts } from "../artifacts.ts";
import {
    executeMainCheckoutRelease,
    planMainCheckoutRelease,
    type MainCheckoutReleasePlan,
} from "../branch.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, branchExists, fetchRepo, remoteBranchExists } from "../git.ts";
import { normalizeHook, runHook } from "../hooks.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import type { GroupState, MultreeConfig, RepoConfig } from "../types.ts";
import { readExposes, wireGroup } from "../wiring.ts";

interface CreateArgs {
    name: string;
    include: string[];
    branch?: string;
    // When set, base each member's worktree on this existing branch instead
    // of cutting a fresh `multree/<group>` branch. The branch is expected to
    // already exist locally or on the remote (we'll fetch first).
    from?: string;
    // Per-repo override of the branch used for that member's worktree. Used
    // when branch names differ across repos for the same logical work.
    branchesByRepo?: Record<string, string>;
}

// Pre-flight plan: everything the main loop needs so it doesn't have to
// re-do discovery work after the worktrees start being created.
interface MemberPlan {
    repoName: string;
    repoCfg: RepoConfig;
    repoPath: string;
    worktreePath: string;
    repoBranch: string;
    releasePlan?: MainCheckoutReleasePlan;
}

export async function createCommand(args: CreateArgs): Promise<void> {
    const { config } = loadConfig();

    if (loadGroup(config, args.name)) {
        throw new Error(`Group "${args.name}" already exists. Destroy it first, or use a different name.`);
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

    const defaultBranch = args.from ?? args.branch ?? `multree/${args.name}`;
    const dir = groupDir(config, args.name);
    if (existsSync(dir)) {
        throw new Error(`Group directory already exists: ${dir}`);
    }

    // ---- Pre-flight: validate every member before any side effects. ----
    const plans = preflight(config, args, defaultBranch, dir);

    // ---- Execute. ----
    mkdirSync(dir, { recursive: true });

    const group: GroupState = {
        name: args.name,
        branch: defaultBranch,
        created_at: new Date().toISOString(),
        members: {},
    };

    // Persist the empty group up front. Each member is then recorded
    // immediately after its worktree exists on disk, BEFORE hooks run --
    // so destroy can always find what to clean up even if a hook throws.
    saveGroup(config, group);

    for (const plan of plans) {
        const { repoName, repoCfg, repoPath, worktreePath, repoBranch } = plan;

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
        };
        saveGroup(config, group);

        if (repoCfg.prime_artifacts && repoCfg.prime_artifacts.length > 0) {
            console.log(`[${repoName}] priming artifacts`);
            primeArtifacts(repoPath, worktreePath, repoCfg.prime_artifacts);
        }

        const installHook = normalizeHook(repoCfg.hooks?.install);
        if (installHook) {
            console.log(`[${repoName}] install hook`);
            const cwd = installHook.cwd === "repo" ? repoPath : worktreePath;
            runHook(installHook.command, cwd);
        }

        const setupHook = normalizeHook(repoCfg.hooks?.setup);
        if (setupHook) {
            console.log(`[${repoName}] setup hook`);
            const cwd = setupHook.cwd === "repo" ? repoPath : worktreePath;
            runHook(setupHook.command, cwd);
        }

        // Capture exposes after this member's setup completed successfully.
        group.members[repoName].exposes = readExposes(worktreePath, repoCfg.exposes);
        saveGroup(config, group);
    }

    console.log("");
    wireGroup(config, group);
    saveGroup(config, group);

    console.log(`\n✓ Group "${args.name}" created on branch "${defaultBranch}"`);
    console.log(`  Group dir: ${dir}`);
    for (const [repoName, member] of Object.entries(group.members)) {
        const tag = member.branch && member.branch !== defaultBranch ? ` (${member.branch})` : "";
        console.log(`  ${repoName}: ${member.path}${tag}`);
        for (const [k, v] of Object.entries(member.exposes)) {
            console.log(`    exposed ${k}=${v}`);
        }
    }
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

        if (existsSync(worktreePath)) {
            errors.push(`[${repoName}] worktree path already exists: ${worktreePath}`);
            continue;
        }

        const release = planMainCheckoutRelease(config, repoCfg, repoName, repoPath, repoBranch);
        if (release.error) {
            errors.push(release.error);
            continue;
        }

        plans.push({
            repoName,
            repoCfg,
            repoPath,
            worktreePath,
            repoBranch,
            releasePlan: release.plan,
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
