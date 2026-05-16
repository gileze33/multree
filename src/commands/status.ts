import { expandPath, loadConfig, resolveBranchBase } from "../config.ts";
import {
    aheadBehind,
    currentBranch,
    fetchRepo,
    isDirty,
    lastCommitSummary,
    refExists,
} from "../git.ts";
import { loadGroup } from "../state.ts";
import type { ConsumeSpec, MultreeConfig } from "../types.ts";
import { buildContext, resolveTemplate } from "../wiring.ts";

interface StatusArgs {
    name: string;
    fetch?: boolean;
}

export function statusCommand(args: StatusArgs): void {
    const { config } = loadConfig();
    const group = loadGroup(config, args.name);
    if (!group) {
        throw new Error(`Group not found: ${args.name}`);
    }

    console.log(`Group: ${group.name}`);
    console.log(`Default branch: ${group.branch}`);
    console.log(`Created: ${group.created_at}`);

    const ctx = buildContext(config, group);

    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        console.log("");
        console.log(`▸ ${repoName}`);
        console.log(`    path: ${member.path}`);

        if (!repoCfg) {
            console.log(`    (no longer in manifest)`);
            continue;
        }

        if (args.fetch) {
            fetchRepo(expandPath(repoCfg.path));
        }

        const branch = currentBranch(member.path) ?? member.branch ?? "?";
        const baseRef = resolveBranchBase(repoCfg);
        const baseAvailable = refExists(member.path, baseRef);
        const ab = baseAvailable ? aheadBehind(member.path, baseRef) : null;
        const dirty = isDirty(member.path);
        const last = lastCommitSummary(member.path);

        const baseLine = ab
            ? `${ab.ahead} ahead / ${ab.behind} behind`
            : baseAvailable
                ? "?"
                : "(base ref unavailable)";
        console.log(`    branch: ${branch}`);
        console.log(`    base: ${baseRef} (${baseLine})`);
        console.log(`    tree: ${dirty ? "dirty" : "clean"}`);
        if (last) {
            const when = last.time ? last.time.toISOString() : "?";
            console.log(`    last: ${last.hash} ${truncate(last.subject, 60)} (${when})`);
        }

        const exposeKeys = Object.keys(member.exposes);
        if (exposeKeys.length > 0) {
            console.log(`    exposes:`);
            for (const k of exposeKeys) {
                console.log(`      ${k} = ${member.exposes[k]}`);
            }
        }

        const consumes = describeConsumes(config, repoCfg.consumes, ctx);
        if (consumes.length > 0) {
            console.log(`    consumes:`);
            for (const line of consumes) {
                console.log(`      ${line}`);
            }
        }
    }
}

function describeConsumes(
    _config: MultreeConfig,
    consumes: ConsumeSpec | ConsumeSpec[] | undefined,
    ctx: Record<string, Record<string, string>>,
): string[] {
    if (!consumes) {
        return [];
    }
    const specs = Array.isArray(consumes) ? consumes : [consumes];
    const lines: string[] = [];
    for (const spec of specs) {
        lines.push(`${spec.file}:`);
        for (const [key, tmpl] of Object.entries(spec.upsert)) {
            let resolved: string;
            try {
                resolved = resolveTemplate(tmpl, ctx);
            } catch (err) {
                resolved = `<unresolved: ${err instanceof Error ? err.message : err}>`;
            }
            lines.push(`  ${key} = ${resolved}`);
        }
    }
    return lines;
}

function truncate(s: string, n: number): string {
    if (s.length <= n) {
        return s;
    }
    return s.slice(0, n - 1) + "…";
}
