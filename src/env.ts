import { existsSync, readFileSync, writeFileSync } from "fs";

export function parseEnvFile(path: string): Record<string, string> {
    if (!existsSync(path)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) {
            continue;
        }
        let value = match[2];
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        out[match[1]] = value;
    }
    return out;
}

const BLOCK_START = (marker: string) => `# >>> multree-managed: ${marker} >>>`;
const BLOCK_END = (marker: string) => `# <<< multree-managed: ${marker} <<<`;

// Reject any key or value containing characters that would let a wired pair
// span multiple lines in the consumer's env file. A literal `\n` or `\r`
// inside a value smuggles arbitrary `KEY=VALUE` lines into the managed block
// (and, if the smuggled content matches the close sentinel, breaks the
// idempotency contract of stripManagedBlock on the next rewire).
function assertSafeForEnvLine(kind: "key" | "value", name: string, s: string): void {
    if (/[\n\r]/.test(s)) {
        throw new Error(
            `Refusing to write env ${kind} "${name}": embedded newline or carriage return ` +
                `would smuggle additional lines into the managed block.`,
        );
    }
}

export function upsertManagedBlock(
    path: string,
    updates: Record<string, string>,
    marker: string,
): void {
    // Validate every entry up front so a single bad value can't leave the
    // file partially rewritten with some pairs in place and the rest missing.
    for (const [k, v] of Object.entries(updates)) {
        assertSafeForEnvLine("key", k, k);
        assertSafeForEnvLine("value", k, v);
    }

    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const stripped = stripManagedBlock(existing, marker);

    const out: string[] = stripped === "" ? [] : stripped.replace(/\s+$/, "").split("\n");

    if (Object.keys(updates).length > 0) {
        if (out.length > 0) {
            out.push("");
        }
        out.push(BLOCK_START(marker));
        for (const [k, v] of Object.entries(updates)) {
            out.push(`${k}=${v}`);
        }
        out.push(BLOCK_END(marker));
    }

    writeFileSync(path, out.join("\n") + "\n");
}

export function removeManagedBlock(path: string, marker: string): void {
    if (!existsSync(path)) {
        return;
    }
    const stripped = stripManagedBlock(readFileSync(path, "utf-8"), marker);
    writeFileSync(path, stripped);
}

function stripManagedBlock(content: string, marker: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    let inside = false;
    for (const line of lines) {
        if (line === BLOCK_START(marker)) {
            inside = true;
            continue;
        }
        if (line === BLOCK_END(marker)) {
            inside = false;
            continue;
        }
        if (!inside) {
            out.push(line);
        }
    }
    return out.join("\n");
}
