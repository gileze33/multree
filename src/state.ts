import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { join } from "path";
import { expandPath } from "./config.ts";
import type { GroupState, MultreeConfig } from "./types.ts";

const STATE_FILENAME = ".multree.json";
const TMP_SUFFIX = ".tmp";

function worktreeRoot(config: MultreeConfig): string {
    return expandPath(config.worktree_root ?? "~/dev/worktree");
}

export function groupDir(config: MultreeConfig, name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error(`Invalid group name: ${name} (alphanumerics, dot, underscore, hyphen only)`);
    }
    return join(worktreeRoot(config), name);
}

// Atomic write: stage to a sibling .tmp then rename over the canonical name.
// rename(2) is atomic on POSIX within the same filesystem, so a crash mid-
// write leaves either the previous committed state or the new one — never a
// truncated `.multree.json` for `--resume` to choke on.
export function saveGroup(config: MultreeConfig, group: GroupState): void {
    const dir = groupDir(config, group.name);
    mkdirSync(dir, { recursive: true });
    const real = join(dir, STATE_FILENAME);
    const tmp = real + TMP_SUFFIX;
    writeFileSync(tmp, JSON.stringify(group, null, 2));
    renameSync(tmp, real);
}

export function loadGroup(config: MultreeConfig, name: string): GroupState | null {
    const dir = groupDir(config, name);
    const real = join(dir, STATE_FILENAME);
    // A stray .tmp is never authoritative: the atomic rename didn't happen,
    // so the canonical file (if any) holds the last committed state. Clean
    // it up on read so resume runs against a tidy directory.
    const tmp = real + TMP_SUFFIX;
    if (existsSync(tmp)) {
        try {
            unlinkSync(tmp);
        } catch {
            // best effort
        }
    }
    if (!existsSync(real)) {
        return null;
    }
    return JSON.parse(readFileSync(real, "utf-8")) as GroupState;
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
