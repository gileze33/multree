import { execFileSync, execSync } from "child_process";

export function substituteCwd(template: string, cwd: string): string {
    return template.replace(/\{cwd\}/g, cwd);
}

// Run a command in the foreground with inherited stdio, substituting `{cwd}`,
// and propagate a non-zero exit code via process.exit so the caller's shell
// sees it. A shell string runs through /bin/bash; an argv array execs directly.
export function runForeground(command: string | string[], cwd: string): void {
    try {
        if (Array.isArray(command)) {
            if (command.length === 0) {
                throw new Error("command argv is empty");
            }
            const [bin, ...rest] = command.map(a => substituteCwd(a, cwd));
            execFileSync(bin, rest, { cwd, stdio: "inherit" });
        } else {
            execSync(substituteCwd(command, cwd), { cwd, stdio: "inherit", shell: "/bin/bash" });
        }
    } catch (err) {
        const code = (err as { status?: number }).status;
        if (typeof code === "number") {
            process.exit(code);
        }
        throw err;
    }
}
