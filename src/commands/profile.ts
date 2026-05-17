import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
    aliasesPath,
    DEFAULT_PROFILE,
    loadAliases,
    profileFilePath,
    resolveManifest,
    resolveMultreeHome,
    resolveProfileName,
} from "../config.ts";

const PROFILE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function validateProfileName(name: string, label: string): void {
    if (!PROFILE_NAME_RE.test(name)) {
        throw new Error(`Invalid ${label}: ${name} (alphanumerics, dot, underscore, hyphen only)`);
    }
}

function writeAliases(path: string, aliases: Record<string, string>): void {
    mkdirSync(dirname(path), { recursive: true });
    const ordered: Record<string, string> = {};
    for (const k of Object.keys(aliases).sort()) {
        ordered[k] = aliases[k];
    }
    writeFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
}

function listProfileFiles(home: string): string[] {
    if (!existsSync(home)) {
        return [];
    }
    return readdirSync(home)
        .filter(f => f.endsWith(".yaml"))
        .map(f => f.slice(0, -".yaml".length))
        .filter(name => PROFILE_NAME_RE.test(name))
        .sort();
}

function pad(s: string, n: number): string {
    return s + " ".repeat(Math.max(0, n - s.length));
}

function listProfiles(): void {
    const home = resolveMultreeHome();
    const profiles = listProfileFiles(home);
    const aliases = loadAliases(home);
    const resolved = resolveManifest();

    console.log(`MULTREE_HOME: ${home}`);

    const aliasSources = new Set(Object.keys(aliases));
    const allNames = new Set<string>([...profiles, ...aliasSources, ...Object.values(aliases)]);
    if (allNames.size === 0) {
        console.log("No profiles or aliases found.");
        return;
    }

    type Row = { name: string; kind: string; target: string; active: string };
    const rows: Row[] = [];
    for (const name of [...allNames].sort()) {
        const isAlias = aliasSources.has(name);
        const isFile = profiles.includes(name);
        let kind: string;
        if (isAlias && isFile) {
            kind = "alias+file";
        } else if (isAlias) {
            kind = "alias";
        } else {
            kind = "file";
        }
        const target = isAlias ? `-> ${aliases[name]}` : "";
        const active = name === resolved.profile ? "*" : "";
        rows.push({ name, kind, target, active });
    }

    const w = {
        active: 1,
        name: Math.max(4, ...rows.map(r => r.name.length)),
        kind: Math.max(4, ...rows.map(r => r.kind.length)),
    };
    console.log(
        `${pad("", w.active)}  ${pad("NAME", w.name)}  ${pad("KIND", w.kind)}  TARGET`,
    );
    for (const r of rows) {
        console.log(
            `${pad(r.active, w.active)}  ${pad(r.name, w.name)}  ${pad(r.kind, w.kind)}  ${r.target}`,
        );
    }
    if (resolved.aliased) {
        console.log(
            `\nActive profile: ${resolved.profile} -> ${resolved.resolvedProfile} (${resolved.path})`,
        );
    } else {
        console.log(`\nActive profile: ${resolved.profile} (${resolved.path})`);
    }
}

function profilePath(name?: string): void {
    const resolved = name ? resolveManifest({ profile: name }) : resolveManifest();
    console.log(resolved.path);
}

function aliasProfile(name: string, target: string): void {
    validateProfileName(name, "alias name");
    validateProfileName(target, "alias target");
    if (name === target) {
        throw new Error(`Cannot alias ${name} to itself`);
    }
    const home = resolveMultreeHome();
    const aliases = loadAliases(home);
    // Reject chains: alias targets must be "leaf" names, never themselves
    // aliased, so the resolver only ever has to do one hop.
    if (Object.prototype.hasOwnProperty.call(aliases, target)) {
        throw new Error(
            `Cannot alias ${name} -> ${target}: ${target} is itself an alias ` +
                `(points at ${aliases[target]}). Aliases must be one-hop only.`,
        );
    }
    if (Object.values(aliases).includes(name)) {
        throw new Error(
            `Cannot alias ${name} -> ${target}: ${name} is already the target of another alias. ` +
                `Aliases must be one-hop only.`,
        );
    }
    aliases[name] = target;
    writeAliases(aliasesPath(home), aliases);
    console.log(`aliased ${name} -> ${target}`);
}

function unaliasProfile(name: string): void {
    validateProfileName(name, "alias name");
    const home = resolveMultreeHome();
    const aliases = loadAliases(home);
    if (!Object.prototype.hasOwnProperty.call(aliases, name)) {
        throw new Error(`No alias for ${name}`);
    }
    delete aliases[name];
    writeAliases(aliasesPath(home), aliases);
    console.log(`removed alias ${name}`);
}

function profileHelp(): void {
    console.log(`multree profile — manage manifest profiles

Usage:
  multree profile list
  multree profile path [<name>]
  multree profile alias <name> <target>
  multree profile unalias <name>

Resolution:
  --profile <name>  >  $MULTREE_PROFILE  >  "${DEFAULT_PROFILE}"
  Then aliases.json (one hop) gives the resolved profile.
  Manifest path: <$MULTREE_HOME or ~/.multree>/<resolved>.yaml
`);
}

export function profileCommand(positional: string[]): void {
    const action = positional[0] ?? "list";
    const rest = positional.slice(1);
    switch (action) {
        case "list":
            listProfiles();
            return;
        case "path":
            profilePath(rest[0]);
            return;
        case "alias": {
            const [name, target] = rest;
            if (!name || !target) {
                throw new Error("profile alias requires <name> <target>");
            }
            aliasProfile(name, target);
            return;
        }
        case "unalias": {
            const [name] = rest;
            if (!name) {
                throw new Error("profile unalias requires <name>");
            }
            unaliasProfile(name);
            return;
        }
        case "help":
        case "--help":
        case "-h":
            profileHelp();
            return;
        default:
            throw new Error(`Unknown profile action: ${action} (try: list, path, alias, unalias)`);
    }
}
