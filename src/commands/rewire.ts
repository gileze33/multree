import { loadConfig } from "../config.ts";
import { loadGroup, saveGroup } from "../state.ts";
import { assignGroupVariables } from "../variables.ts";
import { wireGroup } from "../wiring.ts";

export function rewireCommand(name: string): void {
    const { config, home, profile } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) {
        throw new Error(`Group not found: ${name}`);
    }

    assignGroupVariables(home, profile, config, group);
    wireGroup(config, group);
    saveGroup(config, group);

    console.log(`\n✓ Group "${name}" rewired`);
}
