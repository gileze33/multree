import { cpSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import type { PrimeArtifactSpec, PrimeStrategy } from "./types.ts";

// macOS clonefile(2) on a directory recursively clones the whole tree in a
// single syscall, orders of magnitude faster than `cp -cR` (which walks the
// tree calling clonefile per file). Node has no built-in binding, so shell
// out to python3 + ctypes (ships with Xcode CLT).
const CLONEFILE_PY = `
import ctypes, ctypes.util, sys
libc = ctypes.CDLL(ctypes.util.find_library('System') or 'libSystem.dylib', use_errno=True)
libc.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
libc.clonefile.restype = ctypes.c_int
if libc.clonefile(sys.argv[1].encode(), sys.argv[2].encode(), 0) != 0:
    sys.exit(f"clonefile errno={ctypes.get_errno()}")
`;

function clonefileDir(src: string, dst: string): boolean {
    try {
        execFileSync("python3", ["-c", CLONEFILE_PY, src, dst], { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function resolveSources(repoPath: string, spec: PrimeArtifactSpec): string[] {
    if (spec.path && spec.find) {
        throw new Error("prime_artifacts: specify either 'path' or 'find', not both");
    }
    if (spec.path) {
        return [spec.path];
    }
    if (spec.find) {
        try {
            const out = execFileSync(
                "find",
                [".", "-name", spec.find, "-type", "d", "-prune", "-not", "-path", "*/.git/*"],
                { cwd: repoPath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
            );
            return out.split("\n").filter(Boolean).map(m => m.replace(/^\.\//, ""));
        } catch {
            return [];
        }
    }
    throw new Error("prime_artifacts: must specify 'path' or 'find'");
}

// Whether the destination is already taken. lstat, not an existence check: a
// link whose own target has gone missing reads as absent to `existsSync`, so
// priming would try to create over it. That is not a clean failure for any
// strategy — `cpSync` onto a dangling link aborts the process with a native
// exception no `try`/`catch` can hold, and `symlinkSync` throws EEXIST — so
// all three strategies treat an existing link as occupied and skip it.
function destinationOccupied(dst: string): boolean {
    try {
        lstatSync(dst);
        return true;
    } catch {
        return false;
    }
}

function primeOne(src: string, dst: string, strategy: PrimeStrategy): boolean {
    if (strategy === "symlink") {
        try {
            mkdirSync(dirname(dst), { recursive: true });
            // Absolute target: the repo path multree already resolved. Nothing
            // here goes through the manifest's ~ / ${VAR} expansion, and links
            // inherit that.
            symlinkSync(src, dst);
            return true;
        } catch {
            return false;
        }
    }
    if (strategy === "reflink") {
        if (process.platform === "darwin") {
            if (clonefileDir(src, dst)) {
                return true;
            }
            try {
                execFileSync("cp", ["-cR", src, dst], { stdio: "pipe" });
                return true;
            } catch {
                // fall through to portable copy
            }
        } else if (process.platform === "linux") {
            // GNU cp supports --reflink=auto on btrfs/xfs/bcachefs; falls back
            // to a regular copy on filesystems that don't support reflinks.
            try {
                execFileSync("cp", ["--reflink=auto", "-R", src, dst], { stdio: "pipe" });
                return true;
            } catch {
                // fall through to portable copy
            }
        }
        // On other platforms (or after a fallback), drop through to cpSync.
    }
    try {
        cpSync(src, dst, { recursive: true, dereference: false, errorOnExist: false, force: false });
        return true;
    } catch {
        return false;
    }
}

// Every line carries the repo prefix the phase banner already uses, so a
// multi-repo create says which member each path belongs to. Priming is
// synchronous, so two members' lines can never interleave.
export function primeArtifacts(
    repoName: string,
    repoPath: string,
    worktreePath: string,
    specs: PrimeArtifactSpec[] | undefined,
): void {
    if (!specs || specs.length === 0) {
        return;
    }
    if (!existsSync(repoPath)) {
        return;
    }
    const say = (line: string): void => console.log(`[${repoName}]   ${line}`);

    for (const spec of specs) {
        const strategy: PrimeStrategy = spec.strategy ?? "copy";
        const sources = resolveSources(repoPath, spec);
        if (sources.length === 0) {
            // Only a `find` can resolve to nothing, and it does so silently
            // otherwise — a shared entry naming a file rather than a directory
            // would just never appear.
            say(`skipped find "${spec.find}" (no match in ${repoPath})`);
            continue;
        }

        say(`priming ${sources.length} path(s) via ${strategy}`);
        const totalStart = Date.now();

        for (const rel of sources) {
            const src = join(repoPath, rel);
            const dst = join(worktreePath, rel);
            if (!existsSync(src)) {
                say(`skipped ${rel} (not in ${repoPath})`);
                continue;
            }
            if (destinationOccupied(dst)) {
                say(`skipped ${rel} (destination already exists)`);
                continue;
            }

            const start = Date.now();
            process.stdout.write(`[${repoName}]   ${rel} ... `);
            const ok = primeOne(src, dst, strategy);
            if (!ok) {
                console.log("failed");
                continue;
            }
            // A link's useful fact is where it points; a copy's is how long it
            // took.
            console.log(
                strategy === "symlink"
                    ? `linked -> ${src}`
                    : `${((Date.now() - start) / 1000).toFixed(2)}s`,
            );
        }

        say(`prime complete in ${((Date.now() - totalStart) / 1000).toFixed(1)}s`);
    }
}
