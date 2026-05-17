// Shared "per-member outcome → summary banner → maybe exit(1)" helpers used
// by commands that fan out a single action across every member of a group
// (currently `update` and `push`).

export interface SummaryOutcome {
    repo: string;
    kind: "ok" | "skipped" | "failed";
    // For kind=ok this is rendered parenthesised after the repo name; for
    // kind=skipped/failed it's rendered as the full reason after a colon.
    message: string;
}

export function printSummary(title: string, outcomes: SummaryOutcome[]): void {
    console.log(`\n--- ${title} ---`);
    for (const o of outcomes) {
        if (o.kind === "ok") {
            console.log(`  ✓ ${o.repo} (${o.message})`);
        } else if (o.kind === "skipped") {
            console.log(`  • ${o.repo}: ${o.message}`);
        } else {
            console.log(`  ✗ ${o.repo}: ${o.message}`);
        }
    }
}

export function exitIfAnyFailed(outcomes: SummaryOutcome[]): void {
    if (outcomes.some(o => o.kind === "failed")) {
        process.exit(1);
    }
}

export function indent(text: string, prefix: string): string {
    return text.split("\n").map(l => prefix + l).join("\n");
}
