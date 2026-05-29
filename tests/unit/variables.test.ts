import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GroupState, MultreeConfig, VariableSpec } from "../../src/types.ts";
import {
    allocateMemberVariables,
    assignGroupVariables,
    releaseGroupVariables,
    releaseMemberVariables,
    variablesRegistryPath,
} from "../../src/variables.ts";

const num = (min: number, max: number): VariableSpec => ({ type: "number", min, max });

describe("allocateMemberVariables", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-vars-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("allocates the smallest free value in the range", () => {
        const out = allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, undefined);
        assert.deepEqual(out, { port: "4000" });
    });

    it("gives distinct values to two variables on the same repo", () => {
        const out = allocateMemberVariables(
            home,
            "default",
            "g",
            "web",
            { port: num(4000, 4999), debug: num(4000, 4999) },
            undefined,
        );
        assert.notEqual(out.port, out.debug);
    });

    it("never reuses a value already held by another repo in any group", () => {
        allocateMemberVariables(home, "default", "g1", "web", { port: num(4000, 4999) }, undefined);
        const out = allocateMemberVariables(home, "default", "g2", "api", { port: num(4000, 4999) }, undefined);
        assert.equal(out.port, "4001");
    });

    it("treats values from other variables as in use even with disjoint ranges", () => {
        // Uniqueness is global across every variable, not per-range: api's 4000
        // is unavailable to web even though web's range starts at 4000 too.
        allocateMemberVariables(home, "default", "g", "api", { port: num(4000, 4000) }, undefined);
        const out = allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4001) }, undefined);
        assert.equal(out.port, "4001");
    });

    it("keeps an existing value stable across re-runs", () => {
        const first = allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, undefined);
        const second = allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, first);
        assert.deepEqual(second, first);
    });

    it("isolates allocations across profiles sharing one home", () => {
        const a = allocateMemberVariables(home, "alpha", "g", "web", { port: num(4000, 4999) }, undefined);
        const b = allocateMemberVariables(home, "beta", "g", "web", { port: num(4000, 4999) }, undefined);
        assert.equal(a.port, "4000");
        assert.equal(b.port, "4001", "the beta profile must not reuse alpha's value");
    });

    it("throws when the range is exhausted", () => {
        allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4000) }, undefined);
        assert.throws(
            () => allocateMemberVariables(home, "default", "g", "api", { port: num(4000, 4000) }, undefined),
            /No free value for variable "api\.port" in range \[4000, 4000\]/,
        );
    });

    it("releases a variable that the repo no longer declares", () => {
        allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999), debug: num(4000, 4999) }, undefined);
        const out = allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, { port: "4000", debug: "4001" });
        assert.deepEqual(out, { port: "4000" });
        // 4001 is now free again, so a new repo picks it up.
        const next = allocateMemberVariables(home, "default", "g", "api", { x: num(4000, 4999) }, undefined);
        assert.equal(next.x, "4001");
    });

    it("returns {} and writes no entries when the repo declares no variables", () => {
        const out = allocateMemberVariables(home, "default", "g", "web", undefined, undefined);
        assert.deepEqual(out, {});
    });

    it("persists the ledger to $MULTREE_HOME/variables.json", () => {
        allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, undefined);
        const path = variablesRegistryPath(home);
        assert.ok(existsSync(path));
        const reg = JSON.parse(readFileSync(path, "utf-8")) as {
            version: number;
            allocations: Array<{ profile: string; group: string; repo: string; variable: string; value: number }>;
        };
        assert.equal(reg.version, 1);
        assert.deepEqual(reg.allocations, [
            { profile: "default", group: "g", repo: "web", variable: "port", value: 4000 },
        ]);
    });
});

describe("releaseMemberVariables / releaseGroupVariables", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-vars-rel-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("frees a single member's values for reuse", () => {
        allocateMemberVariables(home, "default", "g1", "web", { port: num(4000, 4999) }, undefined);
        releaseMemberVariables(home, "default", "g1", "web");
        const out = allocateMemberVariables(home, "default", "g2", "web", { port: num(4000, 4999) }, undefined);
        assert.equal(out.port, "4000", "the released value should be reclaimed");
    });

    it("leaves other members untouched when releasing one", () => {
        allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, undefined);
        allocateMemberVariables(home, "default", "g", "api", { port: num(4000, 4999) }, undefined);
        releaseMemberVariables(home, "default", "g", "web");
        // api still holds 4001, so a fresh repo cannot take it.
        const out = allocateMemberVariables(home, "default", "g", "extra", { port: num(4000, 4999) }, undefined);
        assert.equal(out.port, "4000");
    });

    it("frees every value held by a group", () => {
        allocateMemberVariables(home, "default", "g", "web", { port: num(4000, 4999) }, undefined);
        allocateMemberVariables(home, "default", "g", "api", { port: num(4000, 4999) }, undefined);
        releaseGroupVariables(home, "default", "g");
        const reg = JSON.parse(readFileSync(variablesRegistryPath(home), "utf-8")) as {
            allocations: unknown[];
        };
        assert.equal(reg.allocations.length, 0);
    });

    it("only frees the named profile's allocations", () => {
        allocateMemberVariables(home, "alpha", "g", "web", { port: num(4000, 4999) }, undefined);
        allocateMemberVariables(home, "beta", "g", "web", { port: num(4000, 4999) }, undefined);
        releaseGroupVariables(home, "alpha", "g");
        // beta still holds 4001; alpha's 4000 is reclaimable.
        const out = allocateMemberVariables(home, "alpha", "g", "web", { port: num(4000, 4999) }, undefined);
        assert.equal(out.port, "4000");
    });

    it("is a no-op against a missing ledger", () => {
        assert.doesNotThrow(() => releaseMemberVariables(home, "default", "g", "web"));
        assert.doesNotThrow(() => releaseGroupVariables(home, "default", "g"));
        assert.equal(existsSync(variablesRegistryPath(home)), false);
    });
});

describe("assignGroupVariables", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-vars-grp-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    const config: MultreeConfig = {
        version: 1,
        repos: {
            web: { path: "/x", variables: { port: num(4000, 4999) } },
            api: { path: "/y", variables: { port: num(4000, 4999) } },
            plain: { path: "/z" },
        },
    };

    it("assigns distinct values to every member, mutating member state", () => {
        const group: GroupState = {
            name: "g",
            branch: "b",
            created_at: "",
            members: {
                web: { repo: "web", path: "/wt/web", exposes: {} },
                api: { repo: "api", path: "/wt/api", exposes: {} },
                plain: { repo: "plain", path: "/wt/plain", exposes: {} },
            },
        };
        assignGroupVariables(home, "default", config, group);
        assert.equal(group.members.web.variables?.port, "4000");
        assert.equal(group.members.api.variables?.port, "4001");
        assert.deepEqual(group.members.plain.variables, {});
    });
});
