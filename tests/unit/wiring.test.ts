import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ConsumeSpec, ExposeSpec, GroupState, MultreeConfig } from "../../src/types.ts";
import { applyConsumes, buildContext, readExposes, resolveTemplate } from "../../src/wiring.ts";

// Capture every console.warn call made during `fn` and return them as joined
// strings. Restores the original `console.warn` even when `fn` throws.
function captureWarnings(fn: () => void): string[] {
    const original = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
        captured.push(args.map(a => String(a)).join(" "));
    };
    try {
        fn();
    } finally {
        console.warn = original;
    }
    return captured;
}

describe("resolveTemplate", () => {
    it("substitutes {repo.key} from context", () => {
        const ctx = { api: { port: "5100" } };
        assert.equal(resolveTemplate("http://localhost:{api.port}", ctx), "http://localhost:5100");
    });

    it("substitutes multiple variables", () => {
        const ctx = { api: { port: "5100", host: "127.0.0.1" } };
        assert.equal(
            resolveTemplate("http://{api.host}:{api.port}", ctx),
            "http://127.0.0.1:5100",
        );
    });

    it("throws on an unresolved variable", () => {
        assert.throws(() => resolveTemplate("{missing.key}", {}), /could not be resolved/);
    });

    it("throws on a partially-known repo missing the key", () => {
        assert.throws(() => resolveTemplate("{api.host}", { api: { port: "5100" } }));
    });

    it("leaves non-template text untouched", () => {
        assert.equal(resolveTemplate("just a string", {}), "just a string");
    });
});

describe("buildContext", () => {
    const config: MultreeConfig = {
        version: 1,
        repos: {
            api: { path: "/x", defaults: { port: 5000 } },
            rn: { path: "/y" },
        },
    };

    it("includes defaults for repos not in the group", () => {
        const group: GroupState = {
            name: "g",
            branch: "b",
            created_at: "",
            members: { rn: { repo: "rn", path: "/z", exposes: {} } },
        };
        const ctx = buildContext(config, group);
        assert.equal(ctx.api?.port, "5000");
    });

    it("prefers exposed values over defaults", () => {
        const group: GroupState = {
            name: "g",
            branch: "b",
            created_at: "",
            members: { api: { repo: "api", path: "/z", exposes: { port: "5234" } } },
        };
        const ctx = buildContext(config, group);
        assert.equal(ctx.api?.port, "5234");
    });

    it("returns no entry for a repo with no defaults and not in the group", () => {
        const group: GroupState = { name: "g", branch: "b", created_at: "", members: {} };
        const ctx = buildContext(config, group);
        assert.equal(ctx.rn, undefined);
    });

    it("stringifies numeric defaults", () => {
        const group: GroupState = { name: "g", branch: "b", created_at: "", members: {} };
        const ctx = buildContext(config, group);
        assert.equal(typeof ctx.api?.port, "string");
        assert.equal(ctx.api?.port, "5000");
    });
});

describe("buildContext with variable defaults", () => {
    // web has a generated variable with its own fallback; api has both a
    // variable default and an overriding `defaults` map entry.
    const config: MultreeConfig = {
        version: 1,
        repos: {
            web: { path: "/x", variables: { port: { type: "number", min: 4000, max: 4999, default: 9999 } } },
            api: {
                path: "/y",
                variables: { port: { type: "number", min: 5000, max: 5999, default: 5555 } },
                defaults: { port: 5000 },
            },
        },
    };

    it("uses a variable's default for a repo not in the group", () => {
        const group: GroupState = { name: "g", branch: "b", created_at: "", members: {} };
        const ctx = buildContext(config, group);
        assert.equal(ctx.web?.port, "9999");
    });

    it("lets an explicit defaults map entry override the variable default", () => {
        const group: GroupState = { name: "g", branch: "b", created_at: "", members: {} };
        const ctx = buildContext(config, group);
        assert.equal(ctx.api?.port, "5000");
    });

    it("prefers an allocated value over the variable default for a live member", () => {
        const group: GroupState = {
            name: "g",
            branch: "b",
            created_at: "",
            members: { web: { repo: "web", path: "/z", exposes: {}, variables: { port: "4002" } } },
        };
        const ctx = buildContext(config, group);
        assert.equal(ctx.web?.port, "4002");
    });
});

describe("readExposes", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-exposes-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("returns the exposed value when the key is present", () => {
        writeFileSync(join(dir, ".env.local"), "API_PORT=5234\n");
        const spec: Record<string, ExposeSpec> = {
            port: { type: "env_file", file: ".env.local", key: "API_PORT" },
        };
        assert.deepEqual(readExposes(dir, spec), { port: "5234" });
    });

    it("omits keys that are not present in the env file (consumer falls back to defaults)", () => {
        writeFileSync(join(dir, ".env.local"), "other=1\n");
        const spec: Record<string, ExposeSpec> = {
            port: { type: "env_file", file: ".env.local", key: "API_PORT" },
        };
        assert.deepEqual(readExposes(dir, spec), {});
    });

    it("returns {} when no exposes are declared", () => {
        assert.deepEqual(readExposes(dir, undefined), {});
    });

    it("rejects unsupported expose types", () => {
        const spec = {
            port: { type: "stdout_capture", file: "x", key: "y" },
        } as unknown as Record<string, ExposeSpec>;
        assert.throws(() => readExposes(dir, spec), /Unsupported expose type/);
    });
});

// applyConsumes is the wiring sink. The low-level upsertManagedBlock guards
// against `\n`/`\r` smuggling by throwing — applyConsumes self-heals before
// reaching that guard so the user keeps moving when the most common cause is
// just a multi-line YAML default that they almost certainly typo'd.
describe("applyConsumes self-heals embedded newlines in resolved values", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-apply-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("truncates a resolved value at the first newline and writes the prefix", () => {
        const consumes: ConsumeSpec = {
            file: ".env",
            upsert: { API_URL: "http://localhost:{api.port}" },
        };
        const ctx = { api: { port: "5000\nEVIL=injected" } };

        captureWarnings(() => applyConsumes(dir, consumes, "g", ctx));

        const content = readFileSync(join(dir, ".env"), "utf-8");
        assert.match(
            content,
            /^API_URL=http:\/\/localhost:5000$/m,
            "value must be truncated at the first \\n",
        );
        assert.doesNotMatch(content, /EVIL/, "smuggled segment must not be written");
    });

    it("emits a warning naming the consume key and file", () => {
        const consumes: ConsumeSpec = {
            file: ".env",
            upsert: { API_URL: "http://localhost:{api.port}" },
        };
        const ctx = { api: { port: "5000\nEVIL=injected" } };

        const warnings = captureWarnings(() => applyConsumes(dir, consumes, "g", ctx));

        assert.ok(
            warnings.some(w => /API_URL/.test(w) && /newline|stripped/i.test(w) && /\.env/.test(w)),
            `expected a warning mentioning API_URL and .env; got: ${JSON.stringify(warnings)}`,
        );
    });

    it("also strips carriage returns", () => {
        const consumes: ConsumeSpec = {
            file: ".env",
            upsert: { TOKEN: "{api.tok}" },
        };
        const ctx = { api: { tok: "abc123\rEVIL=injected" } };

        captureWarnings(() => applyConsumes(dir, consumes, "g", ctx));

        const content = readFileSync(join(dir, ".env"), "utf-8");
        assert.match(content, /^TOKEN=abc123$/m);
        assert.doesNotMatch(content, /EVIL/);
    });

    it("sanitizes only the offending pairs; clean pairs are written verbatim", () => {
        const consumes: ConsumeSpec = {
            file: ".env",
            upsert: {
                GOOD: "ok",
                BAD: "{api.bad}",
            },
        };
        const ctx = { api: { bad: "first\nsecond" } };

        captureWarnings(() => applyConsumes(dir, consumes, "g", ctx));

        const content = readFileSync(join(dir, ".env"), "utf-8");
        assert.match(content, /^GOOD=ok$/m);
        assert.match(content, /^BAD=first$/m);
        assert.doesNotMatch(content, /second/);
    });

    it("does not warn for values without embedded newlines", () => {
        const consumes: ConsumeSpec = {
            file: ".env",
            upsert: { API_URL: "http://localhost:{api.port}" },
        };
        const ctx = { api: { port: "5234" } };

        const warnings = captureWarnings(() => applyConsumes(dir, consumes, "g", ctx));

        assert.equal(
            warnings.filter(w => /newline|stripped/i.test(w)).length,
            0,
            `expected no newline-related warnings; got: ${JSON.stringify(warnings)}`,
        );
    });
});
