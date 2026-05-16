import { loadConfig } from "../config.ts";
import { loadGroup, saveGroup } from "../state.ts";
import { wireGroup } from "../wiring.ts";

export function rewireCommand(name: string): void {
    const { config } = loadConfig();
    const group = loadGroup(config, name);
    if (!group) {
        throw new Error(`Group not found: ${name}`);
    }

    wireGroup(config, group);
    saveGroup(config, group);

    console.log(`\n✓ Group "${name}" rewired`);
}
