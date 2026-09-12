import { isAbsolute, join } from "path";
import { isAppName, memberConfig } from "./config.ts";
import { parseEnvFile, removeManagedBlock, upsertManagedBlock } from "./env.ts";
import { readMcpServers, writeGroupMcpJson, writeGroupSettingsJson } from "./json.ts";
import { groupDir } from "./state.ts";
import type {
    ConsumeSpec,
    ExposeSpec,
    GroupState,
    MemberConfig,
    MultreeConfig,
} from "./types.ts";

type Context = Record<string, Record<string, string>>;
type Meta = Record<string, string>;

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

// Top-level template names that don't belong to a specific repo. Resolved by
// resolveTemplate alongside the usual {repo.key} form (e.g. {multree_name}
// expands to the group's name). Kept separate from the per-repo context so a
// repo can't accidentally shadow them by exposing a key with the same name.
export function buildMetaContext(group: GroupState): Record<string, string> {
    return {
        multree_name: group.name,
    };
}

export function buildContext(cfg: MultreeConfig, group: GroupState): Context {
    const ctx: Context = {};

    // Seed layer for every declared member (repo or app), so `{member.key}`
    // resolves even when the member isn't in this group. A variable's own
    // `default` seeds its value; an explicit `defaults.<key>` overrides it. The
    // built-in `included` presence token seeds to "" (falsy) here — overridable
    // via `defaults.included` — and is set to "true" for live members below.
    const seedMember = (name: string, mCfg: MemberConfig): void => {
        const seed: Record<string, string> = {
            included:
                mCfg.defaults?.included !== undefined ? String(mCfg.defaults.included) : "",
        };
        if (mCfg.variables) {
            for (const [k, spec] of Object.entries(mCfg.variables)) {
                if (spec.default !== undefined) {
                    seed[k] = String(spec.default);
                }
            }
        }
        if (mCfg.defaults) {
            for (const [k, v] of Object.entries(mCfg.defaults)) {
                seed[k] = String(v);
            }
        }
        ctx[name] = { ...(ctx[name] ?? {}), ...seed };
    };
    for (const [name, repoCfg] of Object.entries(cfg.repos)) {
        seedMember(name, repoCfg);
    }
    for (const [name, appCfg] of Object.entries(cfg.apps ?? {})) {
        seedMember(name, appCfg);
    }

    for (const [name, member] of Object.entries(group.members)) {
        // Precedence within a member: defaults < generated variables < exposes.
        // `included` is authoritative for anything actually in the group, so it
        // wins last (a member can't hide its own presence via an exposed value).
        ctx[name] = {
            ...(ctx[name] ?? {}),
            ...(member.variables ?? {}),
            ...member.exposes,
            included: "true",
        };
    }
    return ctx;
}

export function resolveTemplate(
    template: string,
    context: Record<string, Record<string, string>>,
    meta: Record<string, string> = {},
): string {
    // The optional second group captures the `.key` half of `{repo.key}`; when
    // it's absent we treat the whole match as a top-level name (e.g.
    // `{multree_name}`) and look it up in `meta`.
    return template.replace(/\{([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?\}/g, (full, head, key) => {
        if (key === undefined) {
            if (!(head in meta)) {
                throw new Error(
                    `Template variable "${full}" could not be resolved (no such top-level name).`,
                );
            }
            return meta[head];
        }
        const values = context[head];
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
    meta: Record<string, string> = {},
): void {
    if (!consumes) {
        return;
    }
    const resolved: Record<string, string> = {};
    for (const [k, tmpl] of Object.entries(consumes.upsert)) {
        const raw = resolveTemplate(tmpl, context, meta);
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
    for (const [memberName, member] of Object.entries(group.members)) {
        const mCfg = memberConfig(config, memberName);
        if (!mCfg) {
            console.warn(`[${memberName}] no longer in config; skipping exposes`);
            continue;
        }
        member.exposes = readExposes(member.path, mCfg.exposes);
    }

    const ctx = buildContext(config, group);
    const meta = buildMetaContext(group);
    for (const [memberName, member] of Object.entries(group.members)) {
        const mCfg = memberConfig(config, memberName);
        if (!mCfg?.consumes) {
            continue;
        }
        const specs = Array.isArray(mCfg.consumes) ? mCfg.consumes : [mCfg.consumes];
        console.log(`[${memberName}] wiring env`);
        for (const spec of specs) {
            applyConsumes(member.path, spec, group.name, ctx, meta);
        }
    }

    // Merge every member's `mcps` into the group-root `.mcp.json`, tracking the
    // owned server names in group state so this stays idempotent on rewire.
    group.mcp_servers = wireGroupMcp(config, group, ctx, meta);

    // Opt-in: grant the group-root session file access to the nested repo
    // worktrees via `.claude/settings.json` additionalDirectories.
    if (config.claude_workspace?.additional_directories) {
        group.additional_directories = wireGroupSettings(config, group);
    }
}

// Collect every member's `mcps` block, resolve its templated fields against the
// wiring context, and merge the servers into `<group-root>/.mcp.json`. Returns
// the owned server names for the caller to persist in group state.
function wireGroupMcp(config: MultreeConfig, group: GroupState, ctx: Context, meta: Meta): string[] {
    const servers: Record<string, unknown> = {};
    // Manifest `mcps:` first — these win on any name collision with a hoisted
    // server below.
    for (const memberName of Object.keys(group.members)) {
        const mCfg = memberConfig(config, memberName);
        if (!mCfg?.mcps) {
            continue;
        }
        for (const [serverName, spec] of Object.entries(mCfg.mcps)) {
            servers[serverName] = resolveDeep(spec, ctx, meta);
        }
    }
    // Opt-in: fold each repo member's own checked-in `.mcp.json` servers in, so
    // they are reachable from the group root (Claude never discovers nested
    // `.mcp.json` itself). Apps have no checked-in `.mcp.json`.
    if (config.claude_workspace?.hoist_member_mcps) {
        for (const [memberName, member] of Object.entries(group.members)) {
            if (isAppName(config, memberName)) {
                continue;
            }
            const hoisted = readMcpServers(join(member.path, ".mcp.json"));
            if (!hoisted) {
                continue;
            }
            for (const [serverName, spec] of Object.entries(hoisted)) {
                if (serverName in servers) {
                    console.warn(
                        `  ! mcp server "${serverName}" from ${memberName}/.mcp.json ignored ` +
                            `(a manifest mcps entry or earlier member already defines it)`,
                    );
                    continue;
                }
                servers[serverName] = resolveHoistedServer(spec, member.path);
            }
        }
    }
    const path = join(groupDir(config, group.name), ".mcp.json");
    return writeGroupMcpJson(path, servers, group.mcp_servers ?? []);
}

// A hoisted server's command/args may be written relative to its own repo;
// launched from the group-root cwd they'd resolve wrong. For a stdio server (a
// `command`, no http/sse url) absolutize a relative `command` against the member
// worktree and default `cwd` to that worktree so relative args resolve too.
// http/sse servers and absolute commands are returned unchanged.
export function resolveHoistedServer(spec: unknown, memberPath: string): unknown {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        return spec;
    }
    const s = { ...(spec as Record<string, unknown>) };
    const type = typeof s.type === "string" ? s.type : undefined;
    const isStdio =
        typeof s.command === "string" && s.url === undefined && type !== "http" && type !== "sse";
    if (!isStdio) {
        return s;
    }
    const command = s.command as string;
    if (isRelativeCommandPath(command)) {
        s.command = join(memberPath, command);
    }
    if (s.cwd === undefined) {
        s.cwd = memberPath;
    }
    return s;
}

// A path-like relative command ("./x", "../x", "bin/x") — but not a bare binary
// name ("node", "npx") resolved via PATH, which must be left alone.
function isRelativeCommandPath(cmd: string): boolean {
    if (isAbsolute(cmd)) {
        return false;
    }
    return cmd.startsWith("./") || cmd.startsWith("../") || cmd.includes("/");
}

// Write the group-root `.claude/settings.json` `permissions.additionalDirectories`
// pointing at each repo member's worktree. Apps are plain subdirectories of the
// group root already, so only the nested git-repo worktrees need listing.
function wireGroupSettings(config: MultreeConfig, group: GroupState): string[] {
    const dirs: string[] = [];
    for (const [memberName, member] of Object.entries(group.members)) {
        if (isAppName(config, memberName)) {
            continue;
        }
        dirs.push(member.path);
    }
    const path = join(groupDir(config, group.name), ".claude", "settings.json");
    return writeGroupSettingsJson(path, dirs, group.additional_directories ?? []);
}

// Resolve `{member.key}` tokens in every string within a (possibly nested) mcps
// server spec — url, header values, etc. — leaving non-strings untouched.
function resolveDeep(value: unknown, ctx: Context, meta: Meta): unknown {
    if (typeof value === "string") {
        return resolveTemplate(value, ctx, meta);
    }
    if (Array.isArray(value)) {
        return value.map(v => resolveDeep(v, ctx, meta));
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = resolveDeep(v, ctx, meta);
        }
        return out;
    }
    return value;
}
