import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { computeCandidates, type CompletionContext } from "../../src/completion.ts";

// A representative context: two repos, two groups (one with both repos, one with
// a single repo), a manifest tool, and a couple of profiles.
function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
    return {
        commands: [
            "create",
            "add",
            "remove",
            "list",
            "show",
            "status",
            "update",
            "push",
            "rewire",
            "destroy",
            "profile",
            "shell",
            "completion",
            "help",
        ],
        tools: ["code"],
        repos: ["api", "frontend"],
        groups: [
            { name: "alpha", members: ["api", "frontend"] },
            { name: "beta", members: ["api"] },
        ],
        profiles: ["default", "staging"],
        ...overrides,
    };
}

describe("computeCandidates: subcommand position", () => {
    it("offers every builtin plus manifest tools on an empty line", () => {
        const out = computeCandidates(ctx(), [""]);
        assert.ok(out.includes("create"));
        assert.ok(out.includes("destroy"));
        assert.ok(out.includes("completion"));
        assert.ok(out.includes("code"), "manifest tool should be completable");
    });

    it("treats a fully empty word array as the empty subcommand position", () => {
        assert.deepEqual(computeCandidates(ctx(), []), computeCandidates(ctx(), [""]));
    });

    it("filters subcommands by the typed prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["de"]), ["destroy"]);
    });

    it("offers global flags when the word opens with a dash", () => {
        const out = computeCandidates(ctx(), ["-"]);
        assert.deepEqual(out.sort(), ["--help", "--profile", "--version"]);
    });

    it("de-duplicates a tool that shares a builtin name", () => {
        const out = computeCandidates(ctx({ tools: ["list", "code"] }), ["list"]);
        assert.deepEqual(out, ["list"]);
    });
});

describe("computeCandidates: group positionals", () => {
    it("completes existing groups for destroy", () => {
        assert.deepEqual(computeCandidates(ctx(), ["destroy", ""]), ["alpha", "beta"]);
    });

    it("filters groups by prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["status", "al"]), ["alpha"]);
    });

    it("completes a group for a manifest tool's first positional", () => {
        assert.deepEqual(computeCandidates(ctx(), ["code", ""]), ["alpha", "beta"]);
    });

    it("offers nothing past the group positional for single-arg commands", () => {
        assert.deepEqual(computeCandidates(ctx(), ["destroy", "alpha", ""]), []);
    });

    it("treats create's first positional as a free-text name (no candidates)", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", ""]), []);
    });
});

describe("computeCandidates: repo / member positionals", () => {
    it("completes the named group's members for shell's second positional", () => {
        assert.deepEqual(computeCandidates(ctx(), ["shell", "alpha", ""]), ["api", "frontend"]);
        assert.deepEqual(computeCandidates(ctx(), ["shell", "beta", ""]), ["api"]);
    });

    it("completes members for remove's second positional", () => {
        assert.deepEqual(computeCandidates(ctx(), ["remove", "beta", ""]), ["api"]);
    });

    it("offers only repos NOT already in the group for add", () => {
        // beta has api -> only frontend remains addable.
        assert.deepEqual(computeCandidates(ctx(), ["add", "beta", ""]), ["frontend"]);
        // alpha has both -> nothing left.
        assert.deepEqual(computeCandidates(ctx(), ["add", "alpha", ""]), []);
    });
});

describe("computeCandidates: flags and flag values", () => {
    it("offers a command's flags when the word opens with a dash", () => {
        const out = computeCandidates(ctx(), ["create", "g", "--"]);
        assert.ok(out.includes("--include"));
        assert.ok(out.includes("--branch"));
        assert.ok(out.includes("--profile"), "global --profile should be offered");
    });

    it("filters flags by prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--inc"]), ["--include"]);
    });

    it("completes --strategy with exactly rebase and merge", () => {
        assert.deepEqual(computeCandidates(ctx(), ["update", "g", "--strategy", ""]), [
            "rebase",
            "merge",
        ]);
    });

    it("filters --strategy values by prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["update", "g", "--strategy", "re"]), ["rebase"]);
    });

    it("completes create --include with all repos", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--include", ""]), [
            "api",
            "frontend",
        ]);
    });

    it("completes push --include with the named group's members only", () => {
        assert.deepEqual(computeCandidates(ctx(), ["push", "beta", "--include", ""]), ["api"]);
    });

    it("is comma-aware for --include, dropping already-chosen repos", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--include", "api,"]), [
            "api,frontend",
        ]);
    });

    it("filters the tail after the last comma for --include", () => {
        const c = ctx({ repos: ["api", "frontend", "fonts"] });
        assert.deepEqual(computeCandidates(c, ["create", "g", "--include", "api,f"]), [
            "api,frontend",
            "api,fonts",
        ]);
        // A narrower tail keeps only the matching repo.
        assert.deepEqual(computeCandidates(c, ["create", "g", "--include", "api,fo"]), [
            "api,fonts",
        ]);
    });

    it("offers no candidates for free-text flag values", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--branch", ""]), []);
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--jobs", ""]), []);
    });

    it("treats a dynamic --from-<repo> value as free text", () => {
        assert.deepEqual(computeCandidates(ctx(), ["create", "g", "--from-api", ""]), []);
    });

    it("resumes positional completion after a consumed flag value", () => {
        // `add <group> <repo>` with a --verbose boolean flag in between.
        assert.deepEqual(computeCandidates(ctx(), ["add", "--verbose", "beta", ""]), ["frontend"]);
    });
});

describe("computeCandidates: --profile (global)", () => {
    it("completes profile names as the --profile value", () => {
        assert.deepEqual(computeCandidates(ctx(), ["--profile", ""]), ["default", "staging"]);
    });

    it("filters profiles by prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["--profile", "st"]), ["staging"]);
    });

    it("offers subcommands after a completed --profile pair", () => {
        const out = computeCandidates(ctx(), ["--profile", "staging", ""]);
        assert.ok(out.includes("create"));
        assert.ok(out.includes("destroy"));
    });

    it("resolves group positionals through a leading --profile pair", () => {
        assert.deepEqual(computeCandidates(ctx(), ["--profile", "staging", "destroy", ""]), [
            "alpha",
            "beta",
        ]);
    });
});

describe("computeCandidates: profile subcommand", () => {
    it("completes the profile actions", () => {
        assert.deepEqual(computeCandidates(ctx(), ["profile", ""]), [
            "list",
            "path",
            "alias",
            "unalias",
        ]);
    });

    it("completes a profile name as the alias source", () => {
        assert.deepEqual(computeCandidates(ctx(), ["profile", "alias", ""]), ["default", "staging"]);
    });

    it("completes a profile name as the alias target", () => {
        assert.deepEqual(computeCandidates(ctx(), ["profile", "alias", "default", ""]), [
            "default",
            "staging",
        ]);
    });

    it("completes a profile name for unalias and path", () => {
        assert.deepEqual(computeCandidates(ctx(), ["profile", "unalias", ""]), ["default", "staging"]);
        assert.deepEqual(computeCandidates(ctx(), ["profile", "path", ""]), ["default", "staging"]);
    });

    it("offers nothing for list (takes no further args)", () => {
        assert.deepEqual(computeCandidates(ctx(), ["profile", "list", ""]), []);
    });
});

describe("computeCandidates: completion subcommand", () => {
    it("completes the shell name", () => {
        assert.deepEqual(computeCandidates(ctx(), ["completion", ""]), ["bash", "zsh"]);
    });

    it("filters the shell name by prefix", () => {
        assert.deepEqual(computeCandidates(ctx(), ["completion", "z"]), ["zsh"]);
    });
});

describe("computeCandidates: empty context (no manifest)", () => {
    const bare: CompletionContext = {
        commands: ["create", "destroy", "completion"],
        tools: [],
        repos: [],
        groups: [],
        profiles: [],
    };

    it("still offers builtin subcommands", () => {
        assert.deepEqual(computeCandidates(bare, ["de"]), ["destroy"]);
    });

    it("yields no group candidates when there are no groups", () => {
        assert.deepEqual(computeCandidates(bare, ["destroy", ""]), []);
    });
});
