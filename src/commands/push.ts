import { canPush, loadConfig } from "../config.ts";
import { currentBranch, pushBranch } from "../git.ts";
import { loadGroup } from "../state.ts";
import { exitIfAnyFailed, indent, printSummary, type SummaryOutcome } from "./_outcomes.ts";

interface PushArgs {
    name: string;
    setUpstream?: boolean;
    force?: boolean;
}

export function pushCommand(args: PushArgs): void {
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
        if (!canPush(repoCfg)) {
            console.log(`[${repoName}] push: false in manifest; skipping`);
            outcomes.push({ repo: repoName, kind: "skipped", message: "skipped (push: false)" });
            continue;
        }

        const branch = currentBranch(member.path) ?? member.branch ?? group.branch;
        if (!branch) {
            console.warn(`[${repoName}] could not determine current branch; skipping`);
            outcomes.push({ repo: repoName, kind: "skipped", message: "skipped (no branch resolved)" });
            continue;
        }

        console.log(`\n[${repoName}] pushing ${branch}${args.force ? " (force)" : ""}`);
        const result = pushBranch(member.path, branch, {
            setUpstream: args.setUpstream,
            force: args.force,
        });
        if (result.output.trim()) {
            console.log(indent(result.output.trim(), "  "));
        }
        outcomes.push(
            result.ok
                ? { repo: repoName, kind: "ok", message: branch }
                : { repo: repoName, kind: "failed", message: "push failed" },
        );
    }

    printSummary(`push summary for "${group.name}"`, outcomes);
    exitIfAnyFailed(outcomes);
}
