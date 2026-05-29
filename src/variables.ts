import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { GroupState, MultreeConfig, VariableSpec } from "./types.ts";

// Generated variable values are allocated from a single ledger that lives in
// $MULTREE_HOME, NOT in any group's state. Keeping it home-level (rather than
// per-worktree-root) is deliberate: it lets the uniqueness check span every
// profile, so two profiles drawing ports from overlapping ranges never collide.
//
// Each entry records the (profile, group, repo, variable) it belongs to so the
// value can be released precisely on remove/destroy and reconciled idempotently
// on rewire/resume.

const REGISTRY_FILENAME = "variables.json";
const TMP_SUFFIX = ".tmp";

interface Allocation {
    profile: string;
    group: string;
    repo: string;
    variable: string;
    value: number;
}

interface Registry {
    version: 1;
    allocations: Allocation[];
}

export function variablesRegistryPath(home: string): string {
    return join(home, REGISTRY_FILENAME);
}

function emptyRegistry(): Registry {
    return { version: 1, allocations: [] };
}

function loadRegistry(home: string): Registry {
    const path = variablesRegistryPath(home);
    if (!existsSync(path)) {
        return emptyRegistry();
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as Registry).allocations)) {
        throw new Error(`${path}: expected a variables ledger with an "allocations" array`);
    }
    return raw as Registry;
}

// Atomic write: stage to a sibling .tmp then rename over the canonical name, so
// a crash mid-write never leaves a truncated ledger that the next allocation
// would choke on. Mirrors the approach in state.ts.
function saveRegistry(home: string, reg: Registry): void {
    const path = variablesRegistryPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + TMP_SUFFIX;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
    renameSync(tmp, path);
}

function belongsTo(a: Allocation, profile: string, group: string, repo: string): boolean {
    return a.profile === profile && a.group === group && a.repo === repo;
}

// Smallest unused integer in [min, max] not present in `used`. Smallest-first is
// deterministic (handy for tests and reproducible allocations) and naturally
// reclaims released low values before reaching for higher ones.
function pickFree(min: number, max: number, used: Set<number>): number | undefined {
    for (let v = min; v <= max; v++) {
        if (!used.has(v)) {
            return v;
        }
    }
    return undefined;
}

// Reconcile one member's variable allocations against the global ledger and
// return the resulting { name -> value } map (values stringified for the wiring
// context). Existing values (from state) are preserved so they stay stable
// across rewire/resume; only genuinely new variables draw a fresh number. Any
// previously-allocated variable no longer declared by the repo is released.
export function allocateMemberVariables(
    home: string,
    profile: string,
    group: string,
    repo: string,
    specs: Record<string, VariableSpec> | undefined,
    existing: Record<string, string> | undefined,
): Record<string, string> {
    const reg = loadRegistry(home);

    // Drop this member's prior entries; we re-derive them below. Everything that
    // remains is "in use" by some other variable and must not be reused.
    const others = reg.allocations.filter(a => !belongsTo(a, profile, group, repo));
    const used = new Set<number>(others.map(a => a.value));

    const result: Record<string, string> = {};
    const mine: Allocation[] = [];

    for (const [name, spec] of Object.entries(specs ?? {})) {
        const prior = existing?.[name];
        let value: number | undefined;
        if (prior !== undefined && Number.isInteger(Number(prior)) && !used.has(Number(prior))) {
            // Keep a stable value across re-runs (and out of the way of others).
            value = Number(prior);
        } else {
            value = pickFree(spec.min, spec.max, used);
        }
        if (value === undefined) {
            throw new Error(
                `No free value for variable "${repo}.${name}" in range ` +
                    `[${spec.min}, ${spec.max}] — every value is already in use ` +
                    `across your groups. Widen the range or destroy unused groups.`,
            );
        }
        used.add(value);
        result[name] = String(value);
        mine.push({ profile, group, repo, variable: name, value });
    }

    saveRegistry(home, { version: 1, allocations: [...others, ...mine] });
    return result;
}

// Allocate (or reconcile) variables for every member of the group, mutating
// each member's `variables` in place. The group-state analog of wireGroup:
// create / add / rewire all call this before wiring so the freshly-allocated
// values are visible to consumers.
export function assignGroupVariables(
    home: string,
    profile: string,
    config: MultreeConfig,
    group: GroupState,
): void {
    for (const [repoName, member] of Object.entries(group.members)) {
        const specs = config.repos[repoName]?.variables;
        member.variables = allocateMemberVariables(
            home,
            profile,
            group.name,
            repoName,
            specs,
            member.variables,
        );
    }
}

// Release a single member's values back to the pool (used by `remove`).
export function releaseMemberVariables(
    home: string,
    profile: string,
    group: string,
    repo: string,
): void {
    const reg = loadRegistry(home);
    const remaining = reg.allocations.filter(a => !belongsTo(a, profile, group, repo));
    if (remaining.length === reg.allocations.length) {
        return;
    }
    saveRegistry(home, { version: 1, allocations: remaining });
}

// Release every value held by a group (used by `destroy`).
export function releaseGroupVariables(home: string, profile: string, group: string): void {
    const reg = loadRegistry(home);
    const remaining = reg.allocations.filter(
        a => !(a.profile === profile && a.group === group),
    );
    if (remaining.length === reg.allocations.length) {
        return;
    }
    saveRegistry(home, { version: 1, allocations: remaining });
}
