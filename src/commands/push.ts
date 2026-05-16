import { canPush, loadConfig } from "../config.ts";
import { currentBranch, pushBranch } from "../git.ts";
import { loadGroup } from "../state.ts";
import type { GroupState } from "../types.ts";

interface PushArgs {
    name: string;
    setUpstream?: boolean;
}

interface MemberOutcome {
    repo: string;
    status: "pushed" | "skipped-config" | "skipped-no-branch" | "missing-config" | "failed";
    detail?: string;
}

export function pushCommand(args: PushArgs): void {
    const { config } = loadConfig();
    const group = loadGroup(config, args.name);
    if (!group) {
        throw new Error(`Group not found: ${args.name}`);
    }

    const outcomes: MemberOutcome[] = [];
    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg) {
            console.warn(`[${repoName}] no longer in config; skipping`);
            outcomes.push({ repo: repoName, status: "missing-config" });
            continue;
        }
        if (!canPush(repoCfg)) {
            console.log(`[${repoName}] push: false in manifest; skipping`);
            outcomes.push({ repo: repoName, status: "skipped-config" });
            continue;
        }

        const branch = currentBranch(member.path) ?? member.branch ?? group.branch;
        if (!branch) {
            console.warn(`[${repoName}] could not determine current branch; skipping`);
            outcomes.push({ repo: repoName, status: "skipped-no-branch" });
            continue;
        }

        console.log(`\n[${repoName}] pushing ${branch}`);
        const result = pushBranch(member.path, branch, { setUpstream: args.setUpstream });
        if (result.output.trim()) {
            console.log(indent(result.output.trim(), "  "));
        }
        if (result.ok) {
            outcomes.push({ repo: repoName, status: "pushed", detail: branch });
        } else {
            outcomes.push({ repo: repoName, status: "failed", detail: branch });
        }
    }

    reportPushOutcomes(group, outcomes);
    const failed = outcomes.some(o => o.status === "failed");
    if (failed) {
        process.exit(1);
    }
}

function reportPushOutcomes(group: GroupState, outcomes: MemberOutcome[]): void {
    console.log(`\n--- push summary for "${group.name}" ---`);
    for (const o of outcomes) {
        switch (o.status) {
            case "pushed":
                console.log(`  ✓ ${o.repo} (${o.detail})`);
                break;
            case "skipped-config":
                console.log(`  • ${o.repo}: skipped (push: false)`);
                break;
            case "skipped-no-branch":
                console.log(`  • ${o.repo}: skipped (no branch resolved)`);
                break;
            case "missing-config":
                console.log(`  • ${o.repo}: skipped (no longer in manifest)`);
                break;
            case "failed":
                console.log(`  ✗ ${o.repo}: push failed`);
                break;
        }
    }
}

function indent(text: string, prefix: string): string {
    return text.split("\n").map(l => prefix + l).join("\n");
}
