// cmux integration: build a workspace layout from a group and open/close it via
// the `cmux` CLI. The layout builder and the enable/precedence logic are pure
// (unit-tested); the workspace open/close/list wrappers shell out to `cmux`.
// Best-effort throughout: `create` must never fail because cmux is absent.
import { execFileSync } from "child_process";
import { groupDir, saveGroup } from "./state.ts";
import type {
    CmuxConfig,
    CmuxPaneKind,
    GroupState,
    MultreeConfig,
    RepoConfig,
} from "./types.ts";

// cmux `--layout` JSON: a recursive split tree whose leaf panes each host one or
// more surfaces. Mirrors what `cmux new-workspace --layout` accepts.
export interface LayoutSurface {
    type: "terminal";
    command?: string;
    cwd?: string;
}
export interface PaneNode {
    pane: { surfaces: LayoutSurface[] };
}
export interface SplitNode {
    direction: "horizontal" | "vertical";
    split: number;
    children: LayoutNode[];
}
export type LayoutNode = PaneNode | SplitNode;

// The action verb whose command a "service" pane runs, as
// `multree <verb> <group> <target>`. Dev servers live under `commands.<t>.run`.
const SERVICE_ACTION = "run";
const DEFAULT_SPLIT = 0.5;

// cmux prints deprecation notices to output unless quieted; keep our captures
// clean so ref/UUID parsing is not thrown off.
const CMUX_ENV = { ...process.env, CMUX_QUIET: "1" };

export interface BuiltLayout {
    layout: LayoutNode;
    root: string;
    // Human-readable pane descriptors, in render order, for logging / status.
    panes: string[];
}

// True when multree is running inside a cmux terminal. cmux injects
// CMUX_SOCKET_PATH (among other CMUX_* vars) into every shell it spawns.
export function insideCmux(): boolean {
    const p = process.env.CMUX_SOCKET_PATH;
    return typeof p === "string" && p.length > 0;
}

// Whether `create` should open a cmux workspace. Precedence: an explicit
// `--cmux`/`--no-cmux` override, then `cmux.auto`, then the default (a `cmux`
// block is present AND we're inside cmux).
export function shouldOpenCmux(config: MultreeConfig, override?: boolean): boolean {
    if (override !== undefined) {
        return override;
    }
    if (config.cmux?.auto !== undefined) {
        return config.cmux.auto;
    }
    return config.cmux !== undefined && insideCmux();
}

// Where to place the new workspace in the cmux sidebar: nowhere (ungrouped),
// the caller's current group, or a named group (upserted).
export type GroupTarget =
    | { kind: "none" }
    | { kind: "current" }
    | { kind: "named"; name: string };

// Resolve grouping intent from a CLI override then config. Unset defaults to the
// caller's current group. "none"/"current" are reserved keywords; any other
// value names a group to upsert. Pure.
export function resolveGroupTarget(config: MultreeConfig, override?: string): GroupTarget {
    const raw = override ?? config.cmux?.group ?? "current";
    if (raw === "none") {
        return { kind: "none" };
    }
    if (raw === "current") {
        return { kind: "current" };
    }
    return { kind: "named", name: raw };
}

function normaliseCommand(command: string | string[]): string {
    return Array.isArray(command) ? command.join(" ") : command;
}

function clampSplit(split: number): number {
    if (!Number.isFinite(split)) {
        return DEFAULT_SPLIT;
    }
    return Math.min(0.9, Math.max(0.1, split));
}

// Target keys in a repo that declare the service action (a `run` command).
function serviceTargets(repoCfg: RepoConfig): string[] {
    const out: string[] = [];
    for (const [target, spec] of Object.entries(repoCfg.commands ?? {})) {
        if (spec[SERVICE_ACTION] !== undefined) {
            out.push(target);
        }
    }
    return out;
}

function paneKinds(
    repoKey: string,
    repoCfg: RepoConfig,
    cmuxCfg: CmuxConfig | undefined,
): CmuxPaneKind[] {
    const override = cmuxCfg?.panes?.[repoKey];
    if (override !== undefined) {
        return Array.isArray(override) ? override : [override];
    }
    return serviceTargets(repoCfg).length > 0 ? ["service"] : ["shell"];
}

function claudeCommand(config: MultreeConfig): string {
    const raw = config.cmux?.claude ?? config.tools?.claude?.command ?? "claude";
    return normaliseCommand(raw);
}

// Even vertical stack via nested binary splits: the first child takes 1/N, the
// remainder recurse, so N panes end up equal-height.
function stack(panes: PaneNode[]): LayoutNode {
    if (panes.length === 1) {
        return panes[0];
    }
    const [first, ...rest] = panes;
    return { direction: "vertical", split: 1 / panes.length, children: [first, stack(rest)] };
}

// Pure: (manifest + group state) -> a cmux layout. No fs / no exec. Panes follow
// manifest repo order; each repo contributes service pane(s) and/or a shell pane
// per its resolved kind. Claude is always the left pane.
export function buildLayout(config: MultreeConfig, group: GroupState): BuiltLayout {
    const cmuxCfg = config.cmux;
    const root = groupDir(config, group.name);
    const split = clampSplit(cmuxCfg?.split ?? DEFAULT_SPLIT);

    const descriptors: string[] = ["claude"];
    const rightPanes: PaneNode[] = [];

    for (const [repoKey, repoCfg] of Object.entries(config.repos)) {
        const member = group.members[repoKey];
        if (!member) {
            continue;
        }
        for (const kind of paneKinds(repoKey, repoCfg, cmuxCfg)) {
            if (kind === "skip") {
                continue;
            }
            if (kind === "shell") {
                rightPanes.push({ pane: { surfaces: [{ type: "terminal", cwd: member.path }] } });
                descriptors.push(`${repoKey} (shell)`);
                continue;
            }
            for (const target of serviceTargets(repoCfg)) {
                rightPanes.push({
                    pane: {
                        surfaces: [
                            { type: "terminal", command: `multree run ${group.name} ${target}` },
                        ],
                    },
                });
                descriptors.push(`${target} (${repoKey})`);
            }
        }
    }

    const claudePane: PaneNode = {
        pane: { surfaces: [{ type: "terminal", command: claudeCommand(config) }] },
    };

    const layout: LayoutNode =
        rightPanes.length === 0
            ? claudePane
            : { direction: "horizontal", split, children: [claudePane, stack(rightPanes)] };

    return { layout, root, panes: descriptors };
}

function cmux(args: string[]): string {
    return execFileSync("cmux", args, { encoding: "utf-8", env: CMUX_ENV });
}

// True when the cmux CLI is on PATH and its app socket answers. Best-effort: any
// failure (not installed, app not running, no socket) means "not reachable".
export function cmuxReachable(): boolean {
    try {
        execFileSync("cmux", ["ping"], { stdio: "ignore", env: CMUX_ENV });
        return true;
    } catch {
        return false;
    }
}

// `new-workspace` prints a session-local ref ("OK workspace:12") regardless of
// --id-format; resolve it to a stable UUID via list-workspaces so a later
// session can still find and close it.
function resolveWorkspaceUuid(ref: string): string | null {
    try {
        const rows = cmux(["--id-format", "both", "list-workspaces"]).split("\n");
        for (const row of rows) {
            const tokens = row.trim().split(/\s+/);
            const i = tokens.indexOf(ref);
            const next = tokens[i + 1];
            if (i !== -1 && next && /^[0-9A-Fa-f-]{36}$/.test(next)) {
                return next;
            }
        }
    } catch {
        // fall through to null
    }
    return null;
}

function parseOkRef(out: string): string | null {
    const m = out.match(/\bOK\s+(\S+)/);
    return m ? m[1] : null;
}

interface CmuxGroup {
    id: string;
    name: string;
    member_workspace_ids?: string[];
}

function listCmuxGroups(): CmuxGroup[] {
    const parsed = JSON.parse(cmux(["--id-format", "both", "workspace-group", "list", "--json"]));
    return Array.isArray(parsed.groups) ? (parsed.groups as CmuxGroup[]) : [];
}

// The group the caller's workspace belongs to, via CMUX_WORKSPACE_ID membership.
// null when not inside cmux, or the caller is ungrouped.
function currentGroupId(): string | null {
    const ws = process.env.CMUX_WORKSPACE_ID;
    if (!ws) {
        return null;
    }
    try {
        for (const g of listCmuxGroups()) {
            if (g.member_workspace_ids?.includes(ws)) {
                return g.id;
            }
        }
    } catch {
        // fall through to null
    }
    return null;
}

// Find a group by name, creating it if absent. Returns its id, or null on any
// failure (grouping is best-effort; the workspace still opens ungrouped).
function upsertNamedGroup(name: string): string | null {
    try {
        const existing = listCmuxGroups().find(g => g.name === name);
        if (existing) {
            return existing.id;
        }
        const created = JSON.parse(
            cmux(["--id-format", "both", "workspace-group", "create", "--name", name, "--json"]),
        );
        return created.group?.id ?? null;
    } catch {
        return null;
    }
}

// Resolve grouping intent to a concrete group id to pass to `--group`, or null
// for ungrouped.
function resolveGroupId(target: GroupTarget): string | null {
    if (target.kind === "none") {
        return null;
    }
    if (target.kind === "current") {
        return currentGroupId();
    }
    return upsertNamedGroup(target.name);
}

// Create the workspace from the group's layout, placed in the resolved cmux
// group. Returns the stable workspace UUID (or the session ref if UUID
// resolution failed), or null on failure.
export function openWorkspace(
    config: MultreeConfig,
    group: GroupState,
    focus: boolean,
    groupOverride?: string,
): string | null {
    const { layout, root } = buildLayout(config, group);
    const args = [
        "new-workspace",
        "--name",
        group.name,
        "--cwd",
        root,
        "--focus",
        String(focus),
        "--layout",
        JSON.stringify(layout),
    ];
    const groupId = resolveGroupId(resolveGroupTarget(config, groupOverride));
    if (groupId) {
        args.push("--group", groupId);
    }
    const ref = parseOkRef(cmux(args));
    if (!ref) {
        return null;
    }
    return resolveWorkspaceUuid(ref) ?? ref;
}

export function closeWorkspace(id: string): void {
    try {
        cmux(["close-workspace", "--workspace", id]);
    } catch {
        // Already gone (closed by hand, or a stale id from a previous session).
    }
}

export function workspaceExists(id: string): boolean {
    try {
        return cmux(["--id-format", "both", "list-workspaces"]).includes(id);
    } catch {
        return false;
    }
}

export interface OpenResult {
    status: "opened" | "reused" | "unreachable" | "failed";
    id?: string;
    panes?: string[];
}

// Idempotently ensure the group has an open cmux workspace, persisting the id
// into group state. Best-effort: never throws (create must not fail on cmux).
export function ensureCmuxWorkspace(
    config: MultreeConfig,
    group: GroupState,
    focus: boolean,
    groupOverride?: string,
): OpenResult {
    if (!cmuxReachable()) {
        return { status: "unreachable" };
    }
    const existing = group.cmux?.workspace_id;
    if (existing && workspaceExists(existing)) {
        return { status: "reused", id: existing };
    }
    // A cmux error mid-open (bad layout, transient socket failure) must not fail
    // an otherwise-successful create: this is best-effort, so swallow and report.
    let id: string | null;
    try {
        id = openWorkspace(config, group, focus, groupOverride);
    } catch {
        return { status: "failed" };
    }
    if (!id) {
        return { status: "failed" };
    }
    group.cmux = { workspace_id: id };
    saveGroup(config, group);
    return { status: "opened", id, panes: buildLayout(config, group).panes };
}

// Close the group's cmux workspace (if any) and clear the recorded id. Returns
// true iff a workspace id was recorded. Best-effort on the close itself.
export function teardownCmuxWorkspace(config: MultreeConfig, group: GroupState): boolean {
    const id = group.cmux?.workspace_id;
    if (!id) {
        return false;
    }
    if (cmuxReachable()) {
        closeWorkspace(id);
    }
    delete group.cmux;
    saveGroup(config, group);
    return true;
}

// Shared formatting so `create` and `multree cmux up` report the same way.
export function formatOpenResult(res: OpenResult, groupName: string): { text: string; warn: boolean } {
    switch (res.status) {
        case "opened":
            return { text: `cmux workspace opened: ${(res.panes ?? []).join(", ")}`, warn: false };
        case "reused":
            return { text: `cmux workspace already open for "${groupName}"`, warn: false };
        case "unreachable":
            return {
                text: `cmux not reachable; skipped workspace (run 'multree cmux up ${groupName}' from inside cmux)`,
                warn: true,
            };
        case "failed":
            return { text: `cmux workspace could not be created for "${groupName}"`, warn: true };
    }
}
