import { loadConfig } from "../config.ts";
import { isDirty, lastCommitTime } from "../git.ts";
import { listGroups } from "../state.ts";
import type { GroupState } from "../types.ts";

function formatRelative(date: Date | null): string {
    if (!date) return "—";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
    return date.toISOString().slice(0, 10);
}

function groupLastActivity(group: GroupState): Date | null {
    let max: Date | null = null;
    for (const member of Object.values(group.members)) {
        const t = lastCommitTime(member.path);
        if (t && (!max || t > max)) max = t;
    }
    return max ?? new Date(group.created_at);
}

function groupIsDirty(group: GroupState): boolean {
    return Object.values(group.members).some(m => isDirty(m.path));
}

export function listCommand(): void {
    const { config } = loadConfig();
    const groups = listGroups(config);
    if (groups.length === 0) {
        console.log("No active worktree groups.");
        return;
    }
    const rows = groups.map(g => {
        const dirty = groupIsDirty(g);
        return {
            name: g.name,
            branch: g.branch,
            repos: Object.keys(g.members).join(", "),
            lastCommit: formatRelative(groupLastActivity(g)) + (dirty ? " (dirty)" : ""),
        };
    });
    const w = {
        name: Math.max(4, ...rows.map(r => r.name.length)),
        branch: Math.max(6, ...rows.map(r => r.branch.length)),
        lastCommit: Math.max(11, ...rows.map(r => r.lastCommit.length)),
    };
    const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
    console.log(
        `${pad("NAME", w.name)}  ${pad("BRANCH", w.branch)}  ${pad("LAST COMMIT", w.lastCommit)}  REPOS`,
    );
    for (const r of rows) {
        console.log(
            `${pad(r.name, w.name)}  ${pad(r.branch, w.branch)}  ${pad(r.lastCommit, w.lastCommit)}  ${r.repos}`,
        );
    }
}
