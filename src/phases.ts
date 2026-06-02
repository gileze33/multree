// Shared "run one phase for one member" primitive. `create` invokes this
// inside a parallel scheduler that respects depends_on; `add` invokes it
// inline for a single repo. Centralising it keeps the two commands from
// drifting (new phase, new ordering, new logging).

import { primeArtifacts } from "./artifacts.ts";
import { normalizeHook, runMemberHook } from "./hooks.ts";
import type { MemberState, MultreeConfig, PhaseName, RepoConfig } from "./types.ts";
import { readExposes } from "./wiring.ts";

export interface MemberContext {
    repoName: string;
    groupName: string;
    repoCfg: RepoConfig;
    repoPath: string;
    worktreePath: string;
}

export async function runMemberPhase(
    config: MultreeConfig,
    ctx: MemberContext,
    member: MemberState,
    phase: PhaseName,
    opts: { verbose?: boolean } = {},
): Promise<void> {
    const { repoName, groupName, repoCfg, repoPath, worktreePath } = ctx;
    if (phase === "prime") {
        if (repoCfg.prime_artifacts && repoCfg.prime_artifacts.length > 0) {
            console.log(`[${repoName}] priming artifacts`);
            primeArtifacts(repoPath, worktreePath, repoCfg.prime_artifacts);
        }
        return;
    }
    const hook = normalizeHook(repoCfg.hooks?.[phase]);
    if (!hook) {
        return;
    }
    await runMemberHook({
        phase,
        repoName,
        groupName,
        hook,
        repoPath,
        worktreePath,
        repoCfg,
        config,
        verbose: opts.verbose,
    });
    if (phase === "setup") {
        member.exposes = readExposes(worktreePath, repoCfg.exposes);
    }
}
