import { spawnSync } from "child_process";
import { loadConfig } from "../config.ts";
import { groupDir, loadGroup } from "../state.ts";

export function shellCommand(name: string, repo: string | undefined): void {
    const { config } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) {
        throw new Error(`Group not found: ${name}`);
    }

    let cwd: string;
    if (repo) {
        const member = group.members[repo];
        if (!member) {
            throw new Error(`Repo "${repo}" is not a member of group "${name}"`);
        }
        cwd = member.path;
    } else {
        cwd = groupDir(config, name);
    }

    const shell = process.env.SHELL ?? "/bin/sh";
    const result = spawnSync(shell, [], { cwd, stdio: "inherit" });
    if (typeof result.status === "number") {
        process.exit(result.status);
    }
    if (result.error) {
        throw result.error;
    }
    process.exit(1);
}
