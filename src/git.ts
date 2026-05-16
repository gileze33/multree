import { execSync } from "child_process";
import { existsSync } from "fs";

export function fetchRepo(repoPath: string): void {
    try {
        execSync("git fetch", { cwd: repoPath, stdio: "inherit" });
    } catch (err) {
        console.warn(
            `  ! git fetch failed in ${repoPath}; continuing with local refs. (${err instanceof Error ? err.message : err})`,
        );
    }
}

export function isDirty(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) return false;
    try {
        const out = execSync("git status --porcelain", {
            cwd: worktreePath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return out.trim().length > 0;
    } catch {
        return false;
    }
}

export function lastCommitTime(worktreePath: string): Date | null {
    if (!existsSync(worktreePath)) return null;
    try {
        const iso = execSync("git log -1 --format=%cI", {
            cwd: worktreePath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return iso ? new Date(iso) : null;
    } catch {
        return null;
    }
}

export function branchExists(repoPath: string, branch: string): boolean {
    try {
        execSync(`git show-ref --verify --quiet "refs/heads/${branch}"`, {
            cwd: repoPath,
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

export function addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
): void {
    const useExisting = branchExists(repoPath, branch);
    const flag = useExisting ? "" : `-b "${branch}"`;
    const target = useExisting ? `"${branch}"` : `"${worktreePath}" ${baseRef}`;
    const cmd = useExisting
        ? `git worktree add "${worktreePath}" ${target}`
        : `git worktree add ${flag} "${worktreePath}" "${baseRef}"`;
    execSync(cmd, { cwd: repoPath, stdio: "inherit" });
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
    try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
            cwd: repoPath,
            stdio: "inherit",
        });
    } catch {
        // Worktree may already be missing; prune cleans up dangling refs
        try {
            execSync("git worktree prune", { cwd: repoPath, stdio: "inherit" });
        } catch {
            // ignore
        }
    }
}
