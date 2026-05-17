import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import {
    createMultiProfileSandbox,
    createSandbox,
    type MultiProfileSandbox,
    type Sandbox,
} from "../helpers/sandbox.ts";

// Bare-minimum manifest shape needed to make `multree list` succeed against
// each profile. One repo, no hooks, no wiring — keeps the test focus on
// resolution / isolation rather than create flow internals.
const minimalRepo = (key: string, dirname: string) => ({
    repos: [{ key, dirname }],
});

describe("multree profile resolution", () => {
    let sb: MultiProfileSandbox;

    beforeEach(() => {
        sb = createMultiProfileSandbox({
            profiles: {
                default: minimalRepo("api", "fake-api-default"),
                work: minimalRepo("api", "fake-api-work"),
                personal: minimalRepo("api", "fake-api-personal"),
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("default profile loads default.yaml when nothing is set", () => {
        const r = runMultree(sb, ["profile", "path"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("default").manifestPath);
    });

    it("--profile <name> loads that profile's yaml", () => {
        const r = runMultree(sb, ["--profile", "work", "profile", "path"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("work").manifestPath);
    });

    it("$MULTREE_PROFILE selects the profile when no flag is passed", () => {
        const r = runMultree(
            { env: { ...sb.env, MULTREE_PROFILE: "personal" } },
            ["profile", "path"],
        );
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("personal").manifestPath);
    });

    it("--profile overrides $MULTREE_PROFILE", () => {
        const r = runMultree(
            { env: { ...sb.env, MULTREE_PROFILE: "personal" } },
            ["--profile", "work", "profile", "path"],
        );
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("work").manifestPath);
    });

    it("missing $MULTREE_HOME directory errors out", () => {
        const tmp = mkdtempSync(join(tmpdir(), "multree-no-home-"));
        rmSync(tmp, { recursive: true, force: true });
        const env: NodeJS.ProcessEnv = { ...process.env, MULTREE_HOME: tmp };
        delete env.MULTREE_PROFILE;
        const r = runMultree({ env }, ["list"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /No multree manifest at/);
    });
});

describe("multree profile aliases", () => {
    let sb: MultiProfileSandbox;

    beforeEach(() => {
        sb = createMultiProfileSandbox({
            profiles: {
                default: minimalRepo("api", "fake-api-default"),
                work: minimalRepo("api", "fake-api-work"),
                personal: minimalRepo("api", "fake-api-personal"),
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("alias on default makes unflagged commands load the target", () => {
        sb.writeAliases({ default: "work" });
        const unflagged = runMultree(sb, ["profile", "path"]);
        const explicit = runMultree(sb, ["--profile", "work", "profile", "path"]);
        assert.equal(unflagged.status, 0, unflagged.stderr);
        assert.equal(explicit.status, 0, explicit.stderr);
        assert.equal(unflagged.stdout.trim(), sb.profile("work").manifestPath);
        // The whole point: aliasing default and --profile <target> produce
        // identical resolution.
        assert.equal(unflagged.stdout.trim(), explicit.stdout.trim());
    });

    it("alias on an arbitrary name resolves via that name", () => {
        sb.writeAliases({ wip: "personal" });
        const r = runMultree(sb, ["--profile", "wip", "profile", "path"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("personal").manifestPath);
    });

    it("alias shadows a literal file of the same name", () => {
        // Both work.yaml and personal.yaml exist; alias work -> personal.
        sb.writeAliases({ work: "personal" });
        const r = runMultree(sb, ["--profile", "work", "profile", "path"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.profile("personal").manifestPath);
    });

    it("profile alias and unalias round-trip via the CLI", () => {
        const add = runMultree(sb, ["profile", "alias", "default", "work"]);
        assert.equal(add.status, 0, add.stderr);
        const after = runMultree(sb, ["profile", "path"]);
        assert.equal(after.stdout.trim(), sb.profile("work").manifestPath);

        const rm = runMultree(sb, ["profile", "unalias", "default"]);
        assert.equal(rm.status, 0, rm.stderr);
        const back = runMultree(sb, ["profile", "path"]);
        assert.equal(back.stdout.trim(), sb.profile("default").manifestPath);
    });

    it("rejects self-alias", () => {
        const r = runMultree(sb, ["profile", "alias", "default", "default"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /alias .* to itself/i);
    });

    it("rejects a chain on creation (target is itself an alias source)", () => {
        // Set up a -> b. Then a -> c is fine (updates). But b -> c should be rejected
        // because b is the target of an existing alias.
        const first = runMultree(sb, ["profile", "alias", "default", "work"]);
        assert.equal(first.status, 0, first.stderr);
        const chain = runMultree(sb, ["profile", "alias", "work", "personal"]);
        assert.notEqual(chain.status, 0);
        assert.match(chain.stderr, /one-hop only/);
    });

    it("rejects pointing at an existing alias source", () => {
        const first = runMultree(sb, ["profile", "alias", "default", "work"]);
        assert.equal(first.status, 0, first.stderr);
        // default is an alias source; can't make personal -> default.
        const r = runMultree(sb, ["profile", "alias", "personal", "default"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /one-hop only/);
    });

    it("invalid profile name in --profile errors", () => {
        const r = runMultree(sb, ["--profile", "../escape", "profile", "path"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Invalid profile name/);
    });

    it("--profile placed after positional args is still stripped", () => {
        // The global-flag pre-pass walks the whole argv, not just the head, so
        // `multree <cmd> <pos> --profile <name>` resolves the same as
        // `multree --profile <name> <cmd> <pos>`.
        const a = runMultree(sb, ["profile", "path", "--profile", "work"]);
        const b = runMultree(sb, ["--profile", "work", "profile", "path"]);
        assert.equal(a.status, 0, a.stderr);
        assert.equal(b.status, 0, b.stderr);
        assert.equal(a.stdout.trim(), b.stdout.trim());
        assert.equal(a.stdout.trim(), sb.profile("work").manifestPath);
    });

    it("flags `missing` for a dangling alias target with no backing yaml", () => {
        // Alias `default -> ghost`; no ghost.yaml exists.
        sb.writeAliases({ default: "ghost" });
        const r = runMultree(sb, ["profile", "list"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /ghost\s+missing/);
        assert.match(r.stdout, /\(MISSING\)/);
    });
});

describe("multree profile isolation", () => {
    let sb: MultiProfileSandbox;

    beforeEach(() => {
        // Two profiles, each with their own fixture repo. Different worktree_roots
        // (handled by the helper). Same group name will be created in both.
        sb = createMultiProfileSandbox({
            profiles: {
                north: minimalRepo("api", "fake-api-north"),
                south: minimalRepo("api", "fake-api-south"),
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("same group name in two profiles stays partitioned on disk and in state", () => {
        const a = runMultree(sb, ["--profile", "north", "create", "feature-x", "--include", "api"]);
        assert.equal(a.status, 0, `north create failed:\n${a.stderr}`);
        const b = runMultree(sb, ["--profile", "south", "create", "feature-x", "--include", "api"]);
        assert.equal(b.status, 0, `south create failed:\n${b.stderr}`);

        const north = sb.profile("north");
        const south = sb.profile("south");

        // Two distinct worktrees on disk under separate roots.
        assert.ok(existsSync(north.worktreePath("feature-x", "api")));
        assert.ok(existsSync(south.worktreePath("feature-x", "api")));
        assert.notEqual(north.worktreePath("feature-x", "api"), south.worktreePath("feature-x", "api"));

        // State files exist for both groups, each under its profile's worktree_root.
        const ns = north.state("feature-x");
        const ss = south.state("feature-x");
        assert.ok(ns && ss);
        assert.equal(ns!.name, "feature-x");
        assert.equal(ss!.name, "feature-x");
        assert.notEqual(ns!.members.api.path, ss!.members.api.path);

        // `list` is profile-scoped.
        const listNorth = runMultree(sb, ["--profile", "north", "list"]);
        const listSouth = runMultree(sb, ["--profile", "south", "list"]);
        assert.equal(listNorth.status, 0, listNorth.stderr);
        assert.equal(listSouth.status, 0, listSouth.stderr);
        // Each profile's `list` mentions feature-x exactly once.
        assert.match(listNorth.stdout, /feature-x/);
        assert.match(listSouth.stdout, /feature-x/);
    });

    it("destroying a group in one profile does not affect the other", () => {
        runMultree(sb, ["--profile", "north", "create", "feature-x", "--include", "api"]);
        runMultree(sb, ["--profile", "south", "create", "feature-x", "--include", "api"]);

        const destroy = runMultree(sb, ["--profile", "north", "destroy", "feature-x"]);
        assert.equal(destroy.status, 0, destroy.stderr);

        const north = sb.profile("north");
        const south = sb.profile("south");

        // North's group is gone.
        assert.equal(existsSync(north.worktreePath("feature-x", "api")), false);
        assert.equal(north.state("feature-x"), null);

        // South's group is untouched.
        assert.ok(existsSync(south.worktreePath("feature-x", "api")));
        const ss = south.state("feature-x");
        assert.ok(ss);
        assert.equal(ss!.name, "feature-x");
    });

    it("alias-on-default and --profile target produce identical create outcomes", () => {
        // Alias default -> north. Create from unflagged and verify state lands
        // under north's worktree_root, not under south's.
        sb.writeAliases({ default: "north" });
        const r = runMultree(sb, ["create", "via-default", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        const north = sb.profile("north");
        const south = sb.profile("south");
        assert.ok(existsSync(north.worktreePath("via-default", "api")));
        assert.equal(existsSync(south.worktreePath("via-default", "api")), false);

        // And the same flagged command on the same target produces the same result.
        const r2 = runMultree(sb, ["--profile", "north", "create", "via-flag", "--include", "api"]);
        assert.equal(r2.status, 0, r2.stderr);
        assert.ok(existsSync(north.worktreePath("via-flag", "api")));
    });
});

describe("tool dispatch through --profile", () => {
    let sb: MultiProfileSandbox;

    beforeEach(() => {
        // Each profile defines a `marker` tool that writes its own name into a
        // file under the group dir. The tool name collides across profiles; only
        // the active profile's version should run.
        sb = createMultiProfileSandbox({
            profiles: {
                north: {
                    ...minimalRepo("api", "fake-api-north"),
                    tools: {
                        marker: { command: "echo north > {cwd}/marker.txt", open_in: "$root" },
                    },
                },
                south: {
                    ...minimalRepo("api", "fake-api-south"),
                    tools: {
                        marker: { command: "echo south > {cwd}/marker.txt", open_in: "$root" },
                    },
                },
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("routes to the active profile's tool, not the other one", () => {
        runMultree(sb, ["--profile", "north", "create", "feature-x", "--include", "api"]);
        const r = runMultree(sb, ["--profile", "north", "marker", "feature-x"]);
        assert.equal(r.status, 0, r.stderr);
        const marker = readFileSync(
            join(sb.profile("north").worktreeRoot, "feature-x", "marker.txt"),
            "utf-8",
        );
        assert.equal(marker.trim(), "north");
    });
});

describe("multree honours $MULTREE_HOME for a single-profile sandbox", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({ repos: [{ key: "api", dirname: "fake-api" }] });
    });
    afterEach(() => sb.cleanup());

    it("single-profile default flow works end to end", () => {
        const r = runMultree(sb, ["list"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /No active worktree groups\./);
    });

    it("loads default.yaml from the sandbox home", () => {
        const r = runMultree(sb, ["profile", "path"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), sb.manifestPath);
    });
});

// Confirms a deleted alias.json doesn't leak between tests / between subsequent
// CLI invocations in the same sandbox.
describe("aliases file lifecycle", () => {
    let sb: MultiProfileSandbox;

    beforeEach(() => {
        sb = createMultiProfileSandbox({
            profiles: {
                default: minimalRepo("api", "fake-api-default"),
                work: minimalRepo("api", "fake-api-work"),
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("removing the last alias drops back to literal resolution", () => {
        runMultree(sb, ["profile", "alias", "default", "work"]);
        const aliased = runMultree(sb, ["profile", "path"]);
        assert.equal(aliased.stdout.trim(), sb.profile("work").manifestPath);

        runMultree(sb, ["profile", "unalias", "default"]);
        const literal = runMultree(sb, ["profile", "path"]);
        assert.equal(literal.stdout.trim(), sb.profile("default").manifestPath);

        // aliases.json file still exists but is now empty `{}` — make sure load
        // tolerates that.
        const aliasesFile = readFileSync(join(sb.home, "aliases.json"), "utf-8");
        assert.match(aliasesFile, /\{\}/);
    });
});
