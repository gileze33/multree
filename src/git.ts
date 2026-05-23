import { execFile, execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// All git invocations go through execFileSync with an argv array (no shell),
// so user-controlled values like branch names and paths cannot be
// interpreted as shell metacharacters.

function gitInherit(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "inherit" });
}

function gitSilent(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitCapture(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
    });
}

interface GitResult {
    ok: boolean;
    output: string;
}

// macOS surfaces tmpdirs via /var/folders which is symlinked to
// /private/var/folders. git canonicalises through realpath, so a string
// compare against the path we passed in misidentifies the same on-disk
// location. Canonicalise both sides before comparing.
export function samePath(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return false;
    }
}

function gitTry(cwd: string, args: string[]): GitResult {
    try {
        const output = execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, output };
    } catch (err) {
        const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        const out = e.stdout ? String(e.stdout) : "";
        const errOut = e.stderr ? String(e.stderr) : "";
        return { ok: false, output: `${out}${errOut}${out || errOut ? "" : (e.message ?? "")}` };
    }
}

export function fetchRepo(repoPath: string): void {
    try {
        gitInherit(repoPath, ["fetch"]);
    } catch (err) {
        console.warn(
            `  ! git fetch failed in ${repoPath}; continuing with local refs. (${err instanceof Error ? err.message : err})`,
        );
    }
}

// @deprecated Prefer isDirtyAsync. This sync version blocks the event loop on
// the git subprocess; it survives only for the single-shot callers (branch /
// update / status pre-flight checks) that aren't worth making async yet. Once
// those migrate, delete this so isDirtyAsync is the only copy.
export function isDirty(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) {
        return false;
    }
    try {
        return gitCapture(worktreePath, ["status", "--porcelain"]).trim().length > 0;
    } catch {
        return false;
    }
}

// `list` queries dirty state + last commit time for every member of every
// group; running those git invocations through a bounded pool (rather than
// back-to-back execFileSync) is what keeps `multree list` snappy as the number
// of worktrees grows. Same swallow-and-default semantics as the sync isDirty —
// a single unreadable worktree never fails the listing.
export async function isDirtyAsync(worktreePath: string): Promise<boolean> {
    if (!existsSync(worktreePath)) {
        return false;
    }
    try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
            cwd: worktreePath,
            encoding: "utf-8",
        });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

export async function lastCommitTimeAsync(worktreePath: string): Promise<Date | null> {
    if (!existsSync(worktreePath)) {
        return null;
    }
    try {
        const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%cI"], {
            cwd: worktreePath,
            encoding: "utf-8",
        });
        const iso = stdout.trim();
        return iso ? new Date(iso) : null;
    } catch {
        return null;
    }
}

export interface CommitSummary {
    hash: string;
    subject: string;
    time: Date | null;
}

export function lastCommitSummary(worktreePath: string): CommitSummary | null {
    if (!existsSync(worktreePath)) {
        return null;
    }
    try {
        const out = gitCapture(worktreePath, [
            "log",
            "-1",
            "--format=%h%x09%cI%x09%s",
        ]).trim();
        if (!out) {
            return null;
        }
        const [hash, iso, ...subjectParts] = out.split("\t");
        return {
            hash,
            subject: subjectParts.join("\t"),
            time: iso ? new Date(iso) : null,
        };
    } catch {
        return null;
    }
}

// Returns the branch name when HEAD is a symbolic ref, or null when HEAD is
// detached (or the worktree is unreadable). symbolic-ref is the right
// primitive here: rev-parse --abbrev-ref returns the literal "HEAD" on a
// detached worktree, which silently defeats the `?? member.branch` fallback
// in push/status.
export function currentBranch(worktreePath: string): string | null {
    if (!existsSync(worktreePath)) {
        return null;
    }
    try {
        const out = gitCapture(worktreePath, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
        ]).trim();
        return out || null;
    } catch {
        return null;
    }
}

export function isDetached(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) {
        return false;
    }
    try {
        gitSilent(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
        return false;
    } catch {
        return true;
    }
}

export function branchExists(repoPath: string, branch: string): boolean {
    try {
        gitSilent(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        return true;
    } catch {
        return false;
    }
}

export function remoteBranchExists(
    repoPath: string,
    remote: string,
    branch: string,
): boolean {
    try {
        gitSilent(repoPath, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/remotes/${remote}/${branch}`,
        ]);
        return true;
    } catch {
        return false;
    }
}

export function refExists(repoPath: string, ref: string): boolean {
    try {
        gitSilent(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

export interface WorktreeRecord {
    path: string;
    branch: string | null;
    detached: boolean;
}

export function listWorktrees(repoPath: string): WorktreeRecord[] {
    try {
        const out = gitCapture(repoPath, ["worktree", "list", "--porcelain"]);
        const records: WorktreeRecord[] = [];
        let current: Partial<WorktreeRecord> = {};
        for (const line of out.split("\n")) {
            if (line.startsWith("worktree ")) {
                if (current.path) {
                    records.push({
                        path: current.path,
                        branch: current.branch ?? null,
                        detached: current.detached ?? false,
                    });
                }
                current = { path: line.slice("worktree ".length) };
            } else if (line.startsWith("branch ")) {
                // refs/heads/<branch>
                const ref = line.slice("branch ".length);
                current.branch = ref.replace(/^refs\/heads\//, "");
            } else if (line === "detached") {
                current.detached = true;
            }
        }
        if (current.path) {
            records.push({
                path: current.path,
                branch: current.branch ?? null,
                detached: current.detached ?? false,
            });
        }
        return records;
    } catch {
        return [];
    }
}

export function findBranchCheckout(
    repoPath: string,
    branch: string,
): WorktreeRecord | null {
    return listWorktrees(repoPath).find(w => w.branch === branch) ?? null;
}

export function switchBranch(repoPath: string, branch: string): void {
    gitInherit(repoPath, ["switch", branch]);
}

export function detachHead(repoPath: string): void {
    gitInherit(repoPath, ["switch", "--detach"]);
}

export function addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
): void {
    if (branchExists(repoPath, branch)) {
        const elsewhere = findBranchCheckout(repoPath, branch);
        if (elsewhere && !samePath(elsewhere.path, worktreePath)) {
            throw new Error(
                `Branch "${branch}" is already checked out at ${elsewhere.path} (in ${repoPath}). ` +
                    `Detach or remove that worktree before retrying.`,
            );
        }
        gitInherit(repoPath, ["worktree", "add", worktreePath, branch]);
        return;
    }
    if (remoteBranchExists(repoPath, "origin", branch)) {
        gitInherit(repoPath, [
            "worktree",
            "add",
            "-b",
            branch,
            "--track",
            worktreePath,
            `origin/${branch}`,
        ]);
        return;
    }
    gitInherit(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
    try {
        gitInherit(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch {
        // Worktree may already be missing; prune cleans up dangling refs
        try {
            gitInherit(repoPath, ["worktree", "prune"]);
        } catch {
            // ignore
        }
    }
}

export interface AheadBehind {
    ahead: number;
    behind: number;
}

export function aheadBehind(
    worktreePath: string,
    baseRef: string,
): AheadBehind | null {
    if (!existsSync(worktreePath)) {
        return null;
    }
    try {
        const out = gitCapture(worktreePath, [
            "rev-list",
            "--left-right",
            "--count",
            `${baseRef}...HEAD`,
        ]).trim();
        const [behindStr, aheadStr] = out.split(/\s+/);
        const ahead = Number(aheadStr);
        const behind = Number(behindStr);
        if (Number.isNaN(ahead) || Number.isNaN(behind)) {
            return null;
        }
        return { ahead, behind };
    } catch {
        return null;
    }
}

export function hasUpstream(worktreePath: string): boolean {
    try {
        gitSilent(worktreePath, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ]);
        return true;
    } catch {
        return false;
    }
}

export interface RebaseResult {
    ok: boolean;
    output: string;
}

export function rebaseOnto(worktreePath: string, baseRef: string): RebaseResult {
    const r = gitTry(worktreePath, ["rebase", baseRef]);
    if (!r.ok) {
        // Best-effort abort so we don't leave the worktree mid-rebase.
        gitTry(worktreePath, ["rebase", "--abort"]);
    }
    return r;
}

export function mergeFrom(worktreePath: string, baseRef: string): RebaseResult {
    const r = gitTry(worktreePath, ["merge", "--no-edit", baseRef]);
    if (!r.ok) {
        gitTry(worktreePath, ["merge", "--abort"]);
    }
    return r;
}

export interface PushOptions {
    setUpstream?: boolean;
    remote?: string;
    force?: boolean;
}

export function pushBranch(
    worktreePath: string,
    branch: string,
    opts: PushOptions = {},
): RebaseResult {
    const remote = opts.remote ?? "origin";
    const upstream = opts.setUpstream || !hasUpstream(worktreePath);
    const args = ["push"];
    if (upstream) {
        args.push("--set-upstream");
    }
    if (opts.force) {
        args.push("--force");
    }
    args.push(remote, branch);
    return gitTry(worktreePath, args);
}
