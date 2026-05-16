import { loadConfig } from "../config.ts";
import { loadGroup } from "../state.ts";

export function showCommand(name: string): void {
    const { config } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) {
        console.error(`Group not found: ${name}`);
        process.exit(1);
    }
    console.log(`Group: ${group.name}`);
    console.log(`Branch: ${group.branch}`);
    console.log(`Created: ${group.created_at}`);
    console.log("");
    for (const [repoName, member] of Object.entries(group.members)) {
        console.log(`  ${repoName}`);
        console.log(`    path: ${member.path}`);
        for (const [k, v] of Object.entries(member.exposes)) {
            console.log(`    exposes.${k} = ${v}`);
        }
    }
}
