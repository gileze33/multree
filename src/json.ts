import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

// Merge multree-owned MCP servers into a group-root `.mcp.json` under
// `mcpServers`, keyed by server name.
//
// Unlike the dotenv managed block (env.ts), JSON carries no sentinel comments,
// so ownership is tracked externally by the caller (GroupState.mcp_servers): the
// names multree wrote last time are passed in as `previouslyOwned`, and any that
// are no longer produced are removed. Every other key — foreign `mcpServers`
// entries a human added, and any sibling top-level keys — is preserved verbatim.
//
// Returns the new set of owned server names for the caller to persist.
export function writeGroupMcpJson(
    path: string,
    servers: Record<string, unknown>,
    previouslyOwned: string[],
): string[] {
    const owned = Object.keys(servers);

    let doc: Record<string, unknown> = {};
    if (existsSync(path)) {
        try {
            const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                doc = parsed as Record<string, unknown>;
            }
        } catch {
            // A hand-broken / non-JSON file is not authoritative for our block;
            // start from an empty document rather than throwing and blocking the
            // whole wire step. Foreign content that can't be parsed is lost, but
            // an unparseable .mcp.json was already inert.
            doc = {};
        }
    }

    const existing = doc.mcpServers;
    const mcpServers: Record<string, unknown> =
        existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};

    // Drop owned keys we no longer write; leave foreign keys untouched.
    for (const name of previouslyOwned) {
        if (!(name in servers)) {
            delete mcpServers[name];
        }
    }
    // Upsert the current owned servers.
    for (const [name, spec] of Object.entries(servers)) {
        mcpServers[name] = spec;
    }

    if (Object.keys(mcpServers).length > 0) {
        doc.mcpServers = mcpServers;
    } else {
        delete doc.mcpServers;
    }

    // If nothing is left (no owned servers, no foreign servers, no sibling
    // keys), remove the file so the group root stays clean; otherwise write the
    // merged document back.
    if (Object.keys(doc).length === 0) {
        if (existsSync(path)) {
            unlinkSync(path);
        }
    } else {
        writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    }

    return owned;
}

// Read the `mcpServers` map from a project `.mcp.json`, if present and parseable.
// Returns null when the file is missing or invalid — a broken member `.mcp.json`
// must not block the wire step, so it is treated as "no servers".
export function readMcpServers(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const servers = (parsed as Record<string, unknown>).mcpServers;
            if (servers && typeof servers === "object" && !Array.isArray(servers)) {
                return servers as Record<string, unknown>;
            }
        }
    } catch {
        // Unparseable -> treat as absent.
    }
    return null;
}

// Merge multree-owned entries into `permissions.additionalDirectories` in a
// group-root settings.json. Ownership is tracked externally (GroupState): paths
// we previously wrote that are no longer produced are removed; foreign dirs a
// human added, and every other key, are preserved verbatim. Returns the new
// owned set for the caller to persist.
export function writeGroupSettingsJson(
    path: string,
    dirs: string[],
    previouslyOwned: string[],
): string[] {
    let doc: Record<string, unknown> = {};
    if (existsSync(path)) {
        try {
            const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                doc = parsed as Record<string, unknown>;
            }
        } catch {
            doc = {};
        }
    }

    const permsRaw = doc.permissions;
    const permissions: Record<string, unknown> =
        permsRaw && typeof permsRaw === "object" && !Array.isArray(permsRaw)
            ? { ...(permsRaw as Record<string, unknown>) }
            : {};

    const current = Array.isArray(permissions.additionalDirectories)
        ? (permissions.additionalDirectories as unknown[]).filter(
            (x): x is string => typeof x === "string",
        )
        : [];

    // Drop owned entries we no longer write; leave foreign ones untouched.
    const next = current.filter(d => !(previouslyOwned.includes(d) && !dirs.includes(d)));
    for (const d of dirs) {
        if (!next.includes(d)) {
            next.push(d);
        }
    }

    if (next.length > 0) {
        permissions.additionalDirectories = next;
    } else {
        delete permissions.additionalDirectories;
    }

    if (Object.keys(permissions).length > 0) {
        doc.permissions = permissions;
    } else {
        delete doc.permissions;
    }

    if (Object.keys(doc).length === 0) {
        if (existsSync(path)) {
            unlinkSync(path);
        }
    } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    }

    return dirs;
}
