import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { executeMainCheckoutRelease, planMainCheckoutRelease } from "../branch.ts";
import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import { addWorktree, fetchRepo } from "../git.ts";
import { normalizeHook, runMemberHook } from "../hooks.ts";
import { runMemberPhase } from "../phases.ts";
import { groupDir, loadGroup, saveGroup } from "../state.ts";
import type { MemberState, PhaseName } from "../types.ts";
import { assignGroupVariables } from "../variables.ts";
import { readExposes, wireGroup } from "../wiring.ts";

interface AddOptions {
    verbose?: boolean;
}

const PHASES: PhaseName[] = ["prime", "install", "setup"];

export async function addCommand(
    groupName: string,
    memberName: string,
    opts: AddOptions = {},
): Promise<void> {
    const { config, home, profile } = loadConfig();
    const group = loadGroup(config, groupName);
    if (!group) {
        throw new Error(`Group not found: ${groupName}`);
    }
    if (group.members[memberName]) {
        throw new Error(`Member "${memberName}" is already in group "${groupName}"`);
    }

    // Apps: a scratchpad dir plus an optional setup hook — no worktree, prime, or
    // install. Everything else (variables, wiring, .mcp.json) is the shared path.
    const appCfg = config.apps?.[memberName];
    if (appCfg && !config.repos[memberName]) {
        const scratch = join(groupDir(config, groupName), memberName);
        if (existsSync(scratch)) {
            throw new Error(`Scratchpad path already exists: ${scratch}`);
        }
        mkdirSync(scratch, { recursive: true });
        const member: MemberState = { repo: memberName, kind: "app", path: scratch, exposes: {} };
        group.members[memberName] = member;
        saveGroup(config, group);

        const setup = normalizeHook(appCfg.hooks?.setup);
        if (setup) {
            await runMemberHook({
                phase: "setup",
                repoName: memberName,
                groupName,
                hook: setup,
                repoPath: scratch,
                worktreePath: scratch,
                repoCfg: appCfg,
                config,
                verbose: opts.verbose,
            });
            member.exposes = readExposes(scratch, appCfg.exposes);
        }

        console.log("");
        assignGroupVariables(home, profile, config, group);
        wireGroup(config, group);
        saveGroup(config, group);

        console.log(`\n✓ Added app "${memberName}" to group "${groupName}"`);
        console.log(`  ${memberName}: ${scratch}`);
        return;
    }

    const repoCfg = config.repos[memberName];
    if (!repoCfg) {
        throw new Error(
            `Unknown repo or app "${memberName}". Available: ` +
                `${[...Object.keys(config.repos), ...Object.keys(config.apps ?? {})].join(", ")}`,
        );
    }

    const repoPath = expandPath(repoCfg.path);
    const worktreePath = join(groupDir(config, groupName), basename(repoPath));
    if (existsSync(worktreePath)) {
        throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    console.log(`[${memberName}] git fetch`);
    fetchRepo(repoPath);

    const repoBranch = group.branch;

    const release = planMainCheckoutRelease(config, repoCfg, memberName, repoPath, repoBranch);
    if (release.error) {
        throw new Error(release.error);
    }
    if (release.plan) {
        executeMainCheckoutRelease(memberName, repoPath, repoBranch, release.plan);
    }

    console.log(`[${memberName}] creating worktree at ${worktreePath} (branch: ${repoBranch})`);
    addWorktree(repoPath, worktreePath, repoBranch, resolveBranchBase(repoCfg));

    const member: MemberState = {
        repo: memberName,
        path: worktreePath,
        branch: repoBranch,
        exposes: {},
    };
    group.members[memberName] = member;
    saveGroup(config, group);

    const ctx = { repoName: memberName, groupName, repoCfg, repoPath, worktreePath };
    for (const phase of PHASES) {
        await runMemberPhase(config, ctx, member, phase, { verbose: opts.verbose });
    }

    // Re-wire across the whole group: the new repo's exposes (if any) may
    // affect existing members' consumes, and the new repo's consumes need
    // to be applied against the current context.
    console.log("");
    assignGroupVariables(home, profile, config, group);
    wireGroup(config, group);

    saveGroup(config, group);

    console.log(`\n✓ Added "${memberName}" to group "${groupName}"`);
    console.log(`  ${memberName}: ${worktreePath}`);
}
