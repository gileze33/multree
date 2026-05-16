import { expandPath, loadConfig, resolveBranchBase, resolveUpdateStrategy } from "../config.ts";
import { fetchRepo, isDirty, mergeFrom, rebaseOnto, refExists } from "../git.ts";
import { loadGroup } from "../state.ts";
import type { GroupState, MultreeConfig, RepoConfig, UpdateStrategy } from "../types.ts";

interface UpdateArgs {
    name: string;
    strategy?: UpdateStrategy;
}

interface MemberOutcome {
    repo: string;
    status: "updated" | "skipped-dirty" | "missing-config" | "missing-base" | "failed";
    detail?: string;
}

export function updateCommand(args: UpdateArgs): void {
    const { config } = loadConfig();
    const group = loadGroup(config, args.name);
    if (!group) {
        throw new Error(`Group not found: ${args.name}`);
    }

    if (args.strategy && args.strategy !== "rebase" && args.strategy !== "merge") {
        throw new Error(`Invalid --strategy "${args.strategy}" (expected rebase|merge)`);
    }

    const outcomes: MemberOutcome[] = [];
    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg) {
            console.warn(`[${repoName}] no longer in config; skipping`);
            outcomes.push({ repo: repoName, status: "missing-config" });
            continue;
        }
        outcomes.push(updateOneMember(config, repoCfg, repoName, member.path, args.strategy));
    }

    reportUpdateOutcomes(group, outcomes);
    const failed = outcomes.some(o => o.status === "failed");
    if (failed) {
        process.exit(1);
    }
}

function updateOneMember(
    config: MultreeConfig,
    repoCfg: RepoConfig,
    repoName: string,
    worktreePath: string,
    explicitStrategy: UpdateStrategy | undefined,
): MemberOutcome {
    const repoPath = expandPath(repoCfg.path);
    const baseRef = resolveBranchBase(repoCfg);
    const strategy = explicitStrategy ?? resolveUpdateStrategy(config, repoCfg);

    if (isDirty(worktreePath)) {
        console.log(`[${repoName}] dirty working tree; skipping`);
        return { repo: repoName, status: "skipped-dirty" };
    }

    console.log(`\n[${repoName}] git fetch (${repoPath})`);
    fetchRepo(repoPath);

    if (!refExists(worktreePath, baseRef)) {
        console.warn(`[${repoName}] base ref "${baseRef}" not found; skipping`);
        return { repo: repoName, status: "missing-base", detail: baseRef };
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
        return { repo: repoName, status: "failed", detail: strategy };
    }

    return { repo: repoName, status: "updated", detail: strategy };
}

function reportUpdateOutcomes(group: GroupState, outcomes: MemberOutcome[]): void {
    console.log(`\n--- update summary for "${group.name}" ---`);
    for (const o of outcomes) {
        switch (o.status) {
            case "updated":
                console.log(`  ✓ ${o.repo} (${o.detail})`);
                break;
            case "skipped-dirty":
                console.log(`  • ${o.repo}: skipped (dirty working tree)`);
                break;
            case "missing-base":
                console.log(`  • ${o.repo}: skipped (base ref "${o.detail}" not found)`);
                break;
            case "missing-config":
                console.log(`  • ${o.repo}: skipped (no longer in manifest)`);
                break;
            case "failed":
                console.log(`  ✗ ${o.repo}: ${o.detail} failed; aborted and reset`);
                break;
        }
    }
}

function indent(text: string, prefix: string): string {
    return text.split("\n").map(l => prefix + l).join("\n");
}
