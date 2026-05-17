import { expandPath, loadConfig, resolveBranchBase, resolveUpdateStrategy } from "../config.ts";
import { fetchRepo, isDirty, mergeFrom, rebaseOnto, refExists } from "../git.ts";
import { loadGroup } from "../state.ts";
import type { MultreeConfig, RepoConfig, UpdateStrategy } from "../types.ts";
import { exitIfAnyFailed, indent, printSummary, type SummaryOutcome } from "./_outcomes.ts";

interface UpdateArgs {
    name: string;
    strategy?: UpdateStrategy;
}

export function updateCommand(args: UpdateArgs): void {
    const { config } = loadConfig();
    const group = loadGroup(config, args.name);
    if (!group) {
        throw new Error(`Group not found: ${args.name}`);
    }

    const outcomes: SummaryOutcome[] = [];
    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg) {
            console.warn(`[${repoName}] no longer in config; skipping`);
            outcomes.push({ repo: repoName, kind: "skipped", message: "skipped (no longer in manifest)" });
            continue;
        }
        outcomes.push(updateOneMember(config, repoCfg, repoName, member.path, args.strategy));
    }

    printSummary(`update summary for "${group.name}"`, outcomes);
    exitIfAnyFailed(outcomes);
}

function updateOneMember(
    config: MultreeConfig,
    repoCfg: RepoConfig,
    repoName: string,
    worktreePath: string,
    explicitStrategy: UpdateStrategy | undefined,
): SummaryOutcome {
    const repoPath = expandPath(repoCfg.path);
    const baseRef = resolveBranchBase(repoCfg);
    const strategy = explicitStrategy ?? resolveUpdateStrategy(config, repoCfg);

    if (isDirty(worktreePath)) {
        console.log(`[${repoName}] dirty working tree; skipping`);
        return { repo: repoName, kind: "skipped", message: "skipped (dirty working tree)" };
    }

    console.log(`\n[${repoName}] git fetch (${repoPath})`);
    fetchRepo(repoPath);

    if (!refExists(worktreePath, baseRef)) {
        console.warn(`[${repoName}] base ref "${baseRef}" not found; skipping`);
        return { repo: repoName, kind: "skipped", message: `skipped (base ref "${baseRef}" not found)` };
    }

    console.log(`[${repoName}] ${strategy} ${baseRef} into worktree`);
    const result = strategy === "rebase"
        ? rebaseOnto(worktreePath, baseRef)
        : mergeFrom(worktreePath, baseRef);

    if (!result.ok) {
        console.error(`[${repoName}] ${strategy} failed:`);
        if (result.output.trim()) {
            console.error(indent(result.output.trim(), "  "));
        }
        return { repo: repoName, kind: "failed", message: `${strategy} failed; aborted and reset` };
    }

    return { repo: repoName, kind: "ok", message: strategy };
}
