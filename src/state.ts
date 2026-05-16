import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { expandPath } from "./config.ts";
import type { GroupState, MultreeConfig } from "./types.ts";

const STATE_FILENAME = ".multree.json";

function worktreeRoot(config: MultreeConfig): string {
    return expandPath(config.worktree_root ?? "~/dev/worktree");
}

export function groupDir(config: MultreeConfig, name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error(`Invalid group name: ${name} (alphanumerics, dot, underscore, hyphen only)`);
    }
    return join(worktreeRoot(config), name);
}

export function saveGroup(config: MultreeConfig, group: GroupState): void {
    const dir = groupDir(config, group.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILENAME), JSON.stringify(group, null, 2));
}

export function loadGroup(config: MultreeConfig, name: string): GroupState | null {
    const path = join(groupDir(config, name), STATE_FILENAME);
    if (!existsSync(path)) {
        return null;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as GroupState;
}

export function listGroups(config: MultreeConfig): GroupState[] {
    const root = worktreeRoot(config);
    if (!existsSync(root)) {
        return [];
    }
    const out: GroupState[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const statePath = join(root, entry.name, STATE_FILENAME);
        if (!existsSync(statePath)) {
            continue;
        }
        out.push(JSON.parse(readFileSync(statePath, "utf-8")) as GroupState);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function deleteGroupDir(config: MultreeConfig, name: string): void {
    const dir = groupDir(config, name);
    if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
    }
}
