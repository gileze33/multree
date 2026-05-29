import { join } from "path";
import { parseEnvFile, removeManagedBlock, upsertManagedBlock } from "./env.ts";
import type { ConsumeSpec, ExposeSpec, GroupState, MultreeConfig } from "./types.ts";

export function readExposes(
    memberPath: string,
    exposes: Record<string, ExposeSpec> | undefined,
): Record<string, string> {
    if (!exposes) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [name, spec] of Object.entries(exposes)) {
        if (spec.type !== "env_file") {
            throw new Error(`Unsupported expose type: ${spec.type}`);
        }
        const env = parseEnvFile(join(memberPath, spec.file));
        if (spec.key in env) {
            out[name] = env[spec.key];
        } else {
            console.warn(`  ! ${spec.file} does not contain key "${spec.key}"; skipping ${name}`);
        }
    }
    return out;
}

export function buildContext(
    cfg: MultreeConfig,
    group: GroupState,
): Record<string, Record<string, string>> {
    const ctx: Record<string, Record<string, string>> = {};
    for (const [repo, repoCfg] of Object.entries(cfg.repos)) {
        if (repoCfg.defaults) {
            ctx[repo] = {};
            for (const [k, v] of Object.entries(repoCfg.defaults)) {
                ctx[repo][k] = String(v);
            }
        }
    }
    for (const [repo, member] of Object.entries(group.members)) {
        // Precedence within a repo: defaults < generated variables < exposes.
        // Variables and exposes are both authoritative for live members; if a
        // repo declares both under the same name, the env-file value wins.
        ctx[repo] = { ...(ctx[repo] ?? {}), ...(member.variables ?? {}), ...member.exposes };
    }
    return ctx;
}

export function resolveTemplate(
    template: string,
    context: Record<string, Record<string, string>>,
): string {
    return template.replace(/\{([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\}/g, (full, repo, key) => {
        const values = context[repo];
        if (!values || !(key in values)) {
            throw new Error(
                `Template variable "${full}" could not be resolved (no exposed value or default).`,
            );
        }
        return values[key];
    });
}

// Strip everything from the first newline / carriage return onwards. The
// common cause for one of these landing in a resolved value is a multi-line
// YAML default the user typo'd ("port: |\n  5000" instead of "port: 5000");
// truncating preserves the legitimate prefix while ensuring the smuggled
// suffix never reaches upsertManagedBlock's hard guard.
function sanitizeResolvedValue(value: string): { sanitized: string; stripped: boolean } {
    const idx = value.search(/[\n\r]/);
    if (idx === -1) {
        return { sanitized: value, stripped: false };
    }
    return { sanitized: value.slice(0, idx), stripped: true };
}

export function applyConsumes(
    memberPath: string,
    consumes: ConsumeSpec | undefined,
    marker: string,
    context: Record<string, Record<string, string>>,
): void {
    if (!consumes) {
        return;
    }
    const resolved: Record<string, string> = {};
    for (const [k, tmpl] of Object.entries(consumes.upsert)) {
        const raw = resolveTemplate(tmpl, context);
        const { sanitized, stripped } = sanitizeResolvedValue(raw);
        if (stripped) {
            console.warn(
                `  ! ${consumes.file} ${k}: stripped embedded newline from resolved value; ` +
                    `using "${sanitized}" (check the producer's exposes / defaults)`,
            );
        }
        resolved[k] = sanitized;
    }
    upsertManagedBlock(join(memberPath, consumes.file), resolved, marker);
    console.log(`  wired ${Object.keys(resolved).length} var(s) into ${consumes.file}`);
}

export function clearConsumes(
    memberPath: string,
    consumes: ConsumeSpec | undefined,
    marker: string,
): void {
    if (!consumes) {
        return;
    }
    removeManagedBlock(join(memberPath, consumes.file), marker);
}

/**
 * Single source of truth for env wiring. Re-reads each member's exposes from
 * its worktree env file, then applies every member's consumes block against
 * the resulting context. Called by create, rewire, and (later) add/remove.
 */
export function wireGroup(config: MultreeConfig, group: GroupState): void {
    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg) {
            console.warn(`[${repoName}] no longer in config; skipping exposes`);
            continue;
        }
        member.exposes = readExposes(member.path, repoCfg.exposes);
    }

    const ctx = buildContext(config, group);
    for (const [repoName, member] of Object.entries(group.members)) {
        const repoCfg = config.repos[repoName];
        if (!repoCfg?.consumes) {
            continue;
        }
        const specs = Array.isArray(repoCfg.consumes) ? repoCfg.consumes : [repoCfg.consumes];
        console.log(`[${repoName}] wiring env`);
        for (const spec of specs) {
            applyConsumes(member.path, spec, group.name, ctx);
        }
    }
}
