import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExposeSpec, GroupState, MultreeConfig } from "../../src/types.ts";
import { buildContext, readExposes, resolveTemplate } from "../../src/wiring.ts";

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
