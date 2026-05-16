import { defaultBranchFromBase, resolveMainCheckoutAction } from "./config.ts";
import {
    branchExists,
    detachHead,
    findBranchCheckout,
    isDirty,
    switchBranch,
} from "./git.ts";
import type { MultreeConfig, RepoConfig } from "./types.ts";

// Plan to free a target branch from the source repo's main checkout (if
// needed). Returned as a plan object so callers can validate first, then
// commit later.
export interface MainCheckoutReleasePlan {
    action: "switch" | "detach";
    target?: string;
}

export interface ResolveResult {
    plan?: MainCheckoutReleasePlan;
    error?: string;
}

// Inspects whether `branch` is currently held by some checkout of `repoPath`
// and decides what to do. Returns either:
//   - { plan: undefined }       — nothing to do, the branch is free.
//   - { plan: <release plan> }  — caller must execute the plan to free the branch.
//   - { error: "<message>" }    — the situation is unrecoverable for this run.
export function planMainCheckoutRelease(
    config: MultreeConfig,
    repoCfg: RepoConfig,
    repoName: string,
    repoPath: string,
    branch: string,
): ResolveResult {
    if (!branchExists(repoPath, branch)) {
        return {};
    }
    const elsewhere = findBranchCheckout(repoPath, branch);
    if (!elsewhere) {
        return {};
    }
    if (elsewhere.path !== repoPath) {
        return {
            error:
                `[${repoName}] branch "${branch}" is already checked out in another worktree at ${elsewhere.path}. ` +
                `Detach or remove that worktree before retrying.`,
        };
    }
    const action = resolveMainCheckoutAction(config, repoCfg);
    if (action === "error") {
        return {
            error:
                `[${repoName}] branch "${branch}" is held by the main checkout at ${repoPath}. ` +
                `Switch it manually, or set main_checkout_action to "switch" / "detach".`,
        };
    }
    if (isDirty(repoPath)) {
        return {
            error:
                `[${repoName}] main checkout at ${repoPath} is dirty; can't free branch "${branch}". ` +
                `Commit or stash changes there before retrying.`,
        };
    }
    if (action === "switch") {
        const target = defaultBranchFromBase(repoCfg);
        if (!branchExists(repoPath, target)) {
            return {
                error:
                    `[${repoName}] would switch main checkout off "${branch}" but local branch "${target}" doesn't exist. ` +
                    `Create it, or set main_checkout_action: detach.`,
            };
        }
        return { plan: { action: "switch", target } };
    }
    return { plan: { action: "detach" } };
}

export function executeMainCheckoutRelease(
    repoName: string,
    repoPath: string,
    branch: string,
    plan: MainCheckoutReleasePlan,
): void {
    if (plan.action === "switch" && plan.target) {
        console.log(
            `[${repoName}] freeing branch "${branch}" from main checkout: switching to "${plan.target}"`,
        );
        switchBranch(repoPath, plan.target);
    } else {
        console.log(
            `[${repoName}] freeing branch "${branch}" from main checkout: detaching HEAD`,
        );
        detachHead(repoPath);
    }
}
