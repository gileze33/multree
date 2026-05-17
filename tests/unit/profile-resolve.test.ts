import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    DEFAULT_PROFILE,
    loadAliases,
    resolveManifest,
    resolveMultreeHome,
    resolveProfileName,
} from "../../src/config.ts";

describe("resolveMultreeHome", () => {
    const saved = process.env.MULTREE_HOME;
    afterEach(() => {
        if (saved === undefined) {
            delete process.env.MULTREE_HOME;
        } else {
            process.env.MULTREE_HOME = saved;
        }
    });

    it("uses the explicit override when passed", () => {
        process.env.MULTREE_HOME = "/from/env";
        assert.equal(resolveMultreeHome("/explicit/home"), "/explicit/home");
    });

    it("falls back to $MULTREE_HOME when no explicit value", () => {
        process.env.MULTREE_HOME = "/from/env";
        assert.equal(resolveMultreeHome(), "/from/env");
    });

    it("falls back to ~/.multree when nothing is set", () => {
        delete process.env.MULTREE_HOME;
        const out = resolveMultreeHome();
        assert.ok(out.endsWith("/.multree"), `expected ~/.multree-ish path, got ${out}`);
    });
});

describe("resolveProfileName", () => {
    const saved = process.env.MULTREE_PROFILE;
    afterEach(() => {
        if (saved === undefined) {
            delete process.env.MULTREE_PROFILE;
        } else {
            process.env.MULTREE_PROFILE = saved;
        }
    });

    it("uses the explicit override when passed", () => {
        process.env.MULTREE_PROFILE = "envwins";
        assert.equal(resolveProfileName("explicit"), "explicit");
    });

    it("falls back to $MULTREE_PROFILE", () => {
        process.env.MULTREE_PROFILE = "envprof";
        assert.equal(resolveProfileName(), "envprof");
    });

    it("falls back to the literal default name", () => {
        delete process.env.MULTREE_PROFILE;
        assert.equal(resolveProfileName(), DEFAULT_PROFILE);
    });

    it("rejects names with disallowed characters", () => {
        assert.throws(() => resolveProfileName("../escape"), /Invalid profile name/);
        assert.throws(() => resolveProfileName("has space"), /Invalid profile name/);
        assert.throws(() => resolveProfileName("with/slash"), /Invalid profile name/);
    });
});

describe("loadAliases", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-aliases-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("returns {} when the home dir has no aliases file", () => {
        assert.deepEqual(loadAliases(home), {});
    });

    it("parses a valid aliases.json", () => {
        writeFileSync(
            join(home, "aliases.json"),
            JSON.stringify({ default: "work", wip: "personal" }),
        );
        assert.deepEqual(loadAliases(home), { default: "work", wip: "personal" });
    });

    it("rejects non-object JSON", () => {
        writeFileSync(join(home, "aliases.json"), "[1,2,3]");
        assert.throws(() => loadAliases(home), /expected a JSON object/);
    });

    it("rejects non-string targets", () => {
        writeFileSync(join(home, "aliases.json"), JSON.stringify({ a: 42 }));
        assert.throws(() => loadAliases(home), /target must be a string/);
    });

    it("rejects entries with invalid profile names", () => {
        writeFileSync(join(home, "aliases.json"), JSON.stringify({ "bad name": "work" }));
        assert.throws(() => loadAliases(home), /invalid profile name/);
    });
});

describe("resolveManifest", () => {
    let home: string;
    const savedHome = process.env.MULTREE_HOME;
    const savedProfile = process.env.MULTREE_PROFILE;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "multree-resolve-"));
        mkdirSync(home, { recursive: true });
        process.env.MULTREE_HOME = home;
        delete process.env.MULTREE_PROFILE;
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        if (savedHome === undefined) {
            delete process.env.MULTREE_HOME;
        } else {
            process.env.MULTREE_HOME = savedHome;
        }
        if (savedProfile === undefined) {
            delete process.env.MULTREE_PROFILE;
        } else {
            process.env.MULTREE_PROFILE = savedProfile;
        }
    });

    it("resolves to default.yaml when nothing is set", () => {
        const r = resolveManifest();
        assert.equal(r.profile, "default");
        assert.equal(r.resolvedProfile, "default");
        assert.equal(r.path, join(home, "default.yaml"));
        assert.equal(r.aliased, false);
    });

    it("honours an explicit profile arg over $MULTREE_PROFILE", () => {
        process.env.MULTREE_PROFILE = "envwins";
        const r = resolveManifest({ profile: "explicit" });
        assert.equal(r.profile, "explicit");
        assert.equal(r.path, join(home, "explicit.yaml"));
    });

    it("uses $MULTREE_PROFILE when no flag is passed", () => {
        process.env.MULTREE_PROFILE = "envprof";
        const r = resolveManifest();
        assert.equal(r.profile, "envprof");
        assert.equal(r.path, join(home, "envprof.yaml"));
    });

    it("follows a one-hop alias", () => {
        writeFileSync(join(home, "aliases.json"), JSON.stringify({ default: "work" }));
        const r = resolveManifest();
        assert.equal(r.profile, "default");
        assert.equal(r.resolvedProfile, "work");
        assert.equal(r.aliased, true);
        assert.equal(r.path, join(home, "work.yaml"));
    });

    it("alias on default produces the same path as --profile to the target", () => {
        writeFileSync(join(home, "aliases.json"), JSON.stringify({ default: "work" }));
        const viaAlias = resolveManifest();
        const viaFlag = resolveManifest({ profile: "work" });
        assert.equal(viaAlias.path, viaFlag.path);
    });

    it("alias shadows a literal file of the same name", () => {
        writeFileSync(join(home, "wip.yaml"), "stub: true\n");
        writeFileSync(join(home, "personal.yaml"), "stub: true\n");
        writeFileSync(join(home, "aliases.json"), JSON.stringify({ wip: "personal" }));
        const r = resolveManifest({ profile: "wip" });
        assert.equal(r.resolvedProfile, "personal");
        assert.equal(r.path, join(home, "personal.yaml"));
        assert.equal(r.aliased, true);
    });
});
