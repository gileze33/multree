// Parse a human-friendly duration spec into milliseconds.
//
// Accepts:
//   - "5m", "30s", "2h", "500ms"  — number with unit suffix
//   - "300"                        — bare number, interpreted as seconds
//   - number type                  — interpreted as seconds (manifest YAML
//                                    may yield either a string or a number)
//
// Throws on anything else.
export function parseDuration(spec: string | number): number {
    if (typeof spec === "number") {
        if (!Number.isFinite(spec) || spec < 0) {
            throw new Error(`Invalid duration: ${spec}`);
        }
        return Math.round(spec * 1000);
    }
    const trimmed = spec.trim();
    if (!trimmed) {
        throw new Error("Invalid duration: empty string");
    }
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(trimmed);
    if (!match) {
        throw new Error(`Invalid duration: ${spec}`);
    }
    const value = Number(match[1]);
    const unit = match[2] ?? "s";
    const multipliers: Record<string, number> = {
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
    };
    return Math.round(value * multipliers[unit]);
}

export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(2)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rem = seconds - minutes * 60;
    return `${minutes}m${rem.toFixed(1)}s`;
}
