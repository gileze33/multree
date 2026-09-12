import { execFileSync, execSync } from "child_process";

export function substituteCwd(template: string, cwd: string): string {
    return template.replace(/\{cwd\}/g, cwd);
}

// Run a command in the foreground with inherited stdio, substituting `{cwd}`,
// and propagate a non-zero exit code via process.exit so the caller's shell
// sees it. A shell string runs through /bin/bash; an argv array execs directly.
// `extraEnv` (used by app targets) is layered on top of process.env for the
// child; omit it and the child inherits the ambient environment unchanged.
export function runForeground(
    command: string | string[],
    cwd: string,
    extraEnv?: Record<string, string>,
): void {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    try {
        if (Array.isArray(command)) {
            if (command.length === 0) {
                throw new Error("command argv is empty");
            }
            const [bin, ...rest] = command.map(a => substituteCwd(a, cwd));
            execFileSync(bin, rest, { cwd, stdio: "inherit", env });
        } else {
            execSync(substituteCwd(command, cwd), { cwd, stdio: "inherit", shell: "/bin/bash", env });
        }
    } catch (err) {
        const code = (err as { status?: number }).status;
        if (typeof code === "number") {
            process.exit(code);
        }
        throw err;
    }
}
