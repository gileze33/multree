import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import {
    createMultiProfileSandbox,
    createSandbox,
    trace,
    type MultiProfileSandbox,
    type Sandbox,
} from "../helpers/sandbox.ts";

// `web` owns a generated `port` variable and consumes it into its own env file;
// `api` consumes web's port too. This mirrors the canonical use case: a server
// gets an allocated port, binds to it, and dependents are wired to it.
function makeSandbox(min: number, max: number): Sandbox {
    return createSandbox({
        repos: [
            {
                key: "web",
                setup: trace("web:setup"),
                files: { ".env": "" },
                variables: { port: { type: "number", min, max } },
                // Fallback for consumers when web isn't part of the group; the
                // live generated value always wins over this default.
                defaults: { port: 9999 },
                consumes: { file: ".env", upsert: { PORT: "{web.port}" } },
            },
            {
                key: "api",
                setup: trace("api:setup"),
                files: { ".env": "" },
                consumes: { file: ".env", upsert: { WEB_PORT: "{web.port}" } },
            },
        ],
    });
}

function readPort(sb: Sandbox, group: string, key: string, varName: string): number {
    const content = readFileSync(join(sb.worktreePath(group, key), ".env"), "utf-8");
    const m = content.match(new RegExp(`^${varName}=(\\d+)$`, "m"));
    assert.ok(m, `expected ${varName} in ${key}'s .env; got:\n${content}`);
    return Number(m![1]);
}

interface LedgerEntry {
    profile: string;
    group: string;
    repo: string;
    variable: string;
    value: number;
}

function ledger(home: string): LedgerEntry[] {
    const path = join(home, "variables.json");
    if (!existsSync(path)) {
        return [];
    }
    return (JSON.parse(readFileSync(path, "utf-8")) as { allocations: LedgerEntry[] }).allocations;
}

describe("repo variables", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = makeSandbox(4000, 4999);
    });
    afterEach(() => sb.cleanup());

    it("allocates a value and wires it into the owner and its consumers", () => {
        const r = runMultree(sb, ["create", "g", "--include", "web,api"]);
        assert.equal(r.status, 0, r.stderr);

        const webPort = readPort(sb, "g", "web", "PORT");
        const apiSeesPort = readPort(sb, "g", "api", "WEB_PORT");
        assert.ok(webPort >= 4000 && webPort <= 4999, `port out of range: ${webPort}`);
        assert.equal(apiSeesPort, webPort, "api must see the same port web was allocated");

        // The value is persisted on the owning member's state.
        assert.equal(sb.state("g")?.members.web.variables?.port, String(webPort));
        // ...and recorded in the home-level ledger.
        assert.deepEqual(ledger(sb.home), [
            { profile: "default", group: "g", repo: "web", variable: "port", value: webPort },
        ]);
    });

    it("gives two groups in the same profile distinct values", () => {
        runMultree(sb, ["create", "g1", "--include", "web"]);
        runMultree(sb, ["create", "g2", "--include", "web"]);
        const p1 = readPort(sb, "g1", "web", "PORT");
        const p2 = readPort(sb, "g2", "web", "PORT");
        assert.notEqual(p1, p2, "the second group must not reuse the first group's port");
    });

    it("keeps the value stable across rewire", () => {
        runMultree(sb, ["create", "g", "--include", "web"]);
        const before = readPort(sb, "g", "web", "PORT");
        const r = runMultree(sb, ["rewire", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readPort(sb, "g", "web", "PORT"), before);
    });

    it("reclaims a value once the group is destroyed", () => {
        runMultree(sb, ["create", "g1", "--include", "web"]);
        const first = readPort(sb, "g1", "web", "PORT");
        const d = runMultree(sb, ["destroy", "g1"]);
        assert.equal(d.status, 0, d.stderr);
        assert.deepEqual(ledger(sb.home), [], "destroy must clear the group's allocations");

        runMultree(sb, ["create", "g2", "--include", "web"]);
        assert.equal(readPort(sb, "g2", "web", "PORT"), first, "the freed value should be reused");
    });

    it("reclaims a value when the owning repo is removed from a group", () => {
        runMultree(sb, ["create", "g1", "--include", "web,api"]);
        const held = readPort(sb, "g1", "web", "PORT");
        runMultree(sb, ["create", "g2", "--include", "web"]);
        const other = readPort(sb, "g2", "web", "PORT");
        assert.notEqual(held, other);

        const r = runMultree(sb, ["remove", "g1", "web"]);
        assert.equal(r.status, 0, r.stderr);

        // g1's value is free again; a third group reclaims it.
        runMultree(sb, ["create", "g3", "--include", "web"]);
        assert.equal(readPort(sb, "g3", "web", "PORT"), held);
    });

    it("errors clearly when the range is exhausted", () => {
        const tiny = makeSandbox(4000, 4000);
        try {
            const ok = runMultree(tiny, ["create", "g1", "--include", "web"]);
            assert.equal(ok.status, 0, ok.stderr);
            const fail = runMultree(tiny, ["create", "g2", "--include", "web"]);
            assert.equal(fail.status, 1);
            assert.match(fail.stderr, /No free value for variable "web\.port" in range \[4000, 4000\]/);
        } finally {
            tiny.cleanup();
        }
    });
});

describe("repo variables uniqueness across profiles", () => {
    let sb: MultiProfileSandbox;
    beforeEach(() => {
        // Both profiles draw `port` from the same two-wide range; the ledger in
        // the shared $MULTREE_HOME must stop them colliding.
        const profile = {
            repos: [
                {
                    key: "web",
                    setup: trace("web:setup"),
                    files: { ".env": "" },
                    variables: { port: { type: "number" as const, min: 4000, max: 4001 } },
                    consumes: { file: ".env", upsert: { PORT: "{web.port}" } },
                },
            ],
        };
        sb = createMultiProfileSandbox({ profiles: { alpha: profile, beta: profile } });
    });
    afterEach(() => sb.cleanup());

    it("never hands the same value to two different profiles", () => {
        const a = runMultree(sb, ["--profile", "alpha", "create", "g", "--include", "web"]);
        assert.equal(a.status, 0, a.stderr);
        const b = runMultree(sb, ["--profile", "beta", "create", "g", "--include", "web"]);
        assert.equal(b.status, 0, b.stderr);

        const readP = (p: "alpha" | "beta"): number => {
            const wt = join(sb.profile(p).worktreePath("g", "web"), ".env");
            const m = readFileSync(wt, "utf-8").match(/^PORT=(\d+)$/m);
            assert.ok(m, `expected PORT in ${p}`);
            return Number(m![1]);
        };
        assert.notEqual(readP("alpha"), readP("beta"));
    });
});
