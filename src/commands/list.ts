import { cpus } from "os";
import { loadConfig } from "../config.ts";
import { isDirtyAsync, lastCommitTimeAsync } from "../git.ts";
import { mapPool } from "../scheduler.ts";
import { listGroups } from "../state.ts";

function formatRelative(date: Date | null): string {
    if (!date) {
        return "—";
    }
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) {
        return "just now";
    }
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ago`;
    }
    if (seconds < 86_400) {
        return `${Math.floor(seconds / 3600)}h ago`;
    }
    if (seconds < 7 * 86_400) {
        return `${Math.floor(seconds / 86_400)}d ago`;
    }
    return date.toISOString().slice(0, 10);
}

export async function listCommand(): Promise<void> {
    const { config } = loadConfig();
    const groups = listGroups(config);
    if (groups.length === 0) {
        console.log("No active worktree groups.");
        return;
    }

    // Each member needs two git probes (dirty status + last commit time). With
    // many groups × repos that fan-out dominates runtime, so flatten every
    // probe across all groups into one list and run it through a bounded pool
    // rather than spawning git back-to-back. `jobs` caps concurrent git
    // processes; default to one per core.
    const jobs = Math.max(1, config.jobs ?? cpus().length);
    interface Probe {
        group: number;
        kind: "dirty" | "time";
        path: string;
    }
    const probes: Probe[] = [];
    groups.forEach((g, gi) => {
        for (const member of Object.values(g.members)) {
            probes.push({ group: gi, kind: "dirty", path: member.path });
            probes.push({ group: gi, kind: "time", path: member.path });
        }
    });

    const dirty = groups.map(() => false);
    const lastActivity: (Date | null)[] = groups.map(() => null);
    await mapPool(probes, jobs, async probe => {
        if (probe.kind === "dirty") {
            if (await isDirtyAsync(probe.path)) {
                dirty[probe.group] = true;
            }
            return;
        }
        const t = await lastCommitTimeAsync(probe.path);
        const cur = lastActivity[probe.group];
        if (t && (!cur || t > cur)) {
            lastActivity[probe.group] = t;
        }
    });

    const rows = groups.map((g, gi) => ({
        name: g.name,
        branch: g.branch,
        repos: Object.keys(g.members).join(", "),
        lastCommit:
            formatRelative(lastActivity[gi] ?? new Date(g.created_at)) +
            (dirty[gi] ? " (dirty)" : ""),
    }));
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
