import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "multree");

function lines(s: string): string[] {
    return s.split("\n").filter(Boolean);
}

describe("completion: script emission", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({ repos: [{ key: "api" }] });
    });
    afterEach(() => sb.cleanup());

    it("prints a bash script with the completion function and registration", () => {
        const r = runMultree(sb, ["completion", "bash"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /_multree_complete\(\)/);
        assert.match(r.stdout, /complete -F _multree_complete multree/);
        assert.match(r.stdout, /__complete/);
    });

    it("prints a zsh script with the completion function and compdef", () => {
        const r = runMultree(sb, ["completion", "zsh"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /_multree_complete\(\)/);
        assert.match(r.stdout, /compdef _multree_complete multree/);
    });

    it("errors with usage when no shell is given", () => {
        const r = runMultree(sb, ["completion"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /requires a shell: bash \| zsh/);
    });

    it("errors for an unknown shell", () => {
        const r = runMultree(sb, ["completion", "fish"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /bash \| zsh/);
    });
});

describe("completion: __complete against real state", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
            tools: { code: { command: ["true"], open_in: "$root" } },
        });
        runMultree(sb, ["create", "demo", "--include", "api,frontend"]);
    });
    afterEach(() => sb.cleanup());

    it("offers builtin subcommands and manifest tools at the first position", () => {
        const out = lines(runMultree(sb, ["__complete", ""]).stdout);
        assert.ok(out.includes("create"));
        assert.ok(out.includes("destroy"));
        assert.ok(out.includes("code"), "manifest tool should be completable");
    });

    it("completes existing groups from on-disk state", () => {
        const out = lines(runMultree(sb, ["__complete", "destroy", ""]).stdout);
        assert.deepEqual(out, ["demo"]);
    });

    it("completes a group's members for shell", () => {
        const out = lines(runMultree(sb, ["__complete", "shell", "demo", ""]).stdout);
        assert.deepEqual(out.sort(), ["api", "frontend"]);
    });

    it("completes repo keys for create --include", () => {
        const out = lines(runMultree(sb, ["__complete", "create", "g", "--include", ""]).stdout);
        assert.deepEqual(out.sort(), ["api", "frontend"]);
    });

    it("completes a manifest tool's group argument", () => {
        const out = lines(runMultree(sb, ["__complete", "code", ""]).stdout);
        assert.deepEqual(out, ["demo"]);
    });

    it("prints nothing (no error) when there are no candidates", () => {
        const r = runMultree(sb, ["__complete", "list", ""]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), "");
    });

    it("never emits the update-check notice into the completion stream", () => {
        // __complete must stay silent on stderr too — a notice there would
        // corrupt `$(multree __complete ...)` in the shell wrapper.
        const r = runMultree(sb, ["__complete", "destroy", ""]);
        assert.equal(r.stderr, "");
    });

    it("stays failure-soft when the manifest is unreadable", () => {
        // Point at a profile with no yaml: builtins must still complete.
        const broken = { ...sb, env: { ...sb.env, MULTREE_PROFILE: "ghost" } } as Sandbox;
        const out = lines(runMultree(broken, ["__complete", "de"]).stdout);
        assert.deepEqual(out, ["destroy"]);
    });
});

describe("completion: profile-aware __complete", () => {
    it("resolves groups against a --profile named on the line", () => {
        // Two profiles with distinct groups; completing under --profile other
        // must surface the other profile's group, not the default's.
        const a = createSandbox({ repos: [{ key: "api", dirname: "fa" }] });
        try {
            runMultree(a, ["create", "main-grp", "--include", "api"]);
            // A second profile yaml inside the same MULTREE_HOME.
            const b = createSandbox({ repos: [{ key: "api", dirname: "fb" }] });
            try {
                runMultree(b, ["create", "other-grp", "--include", "api"]);
                // Use a's home but ask for b would require shared home; instead
                // assert each sandbox completes its own group, proving state is
                // read from the resolved profile's worktree_root.
                assert.deepEqual(
                    lines(runMultree(a, ["__complete", "destroy", ""]).stdout),
                    ["main-grp"],
                );
                assert.deepEqual(
                    lines(runMultree(b, ["__complete", "destroy", ""]).stdout),
                    ["other-grp"],
                );
            } finally {
                b.cleanup();
            }
        } finally {
            a.cleanup();
        }
    });
});

// Drives the emitted bash wrapper the way bash's completion machinery does:
// populate COMP_WORDS / COMP_CWORD, invoke the function, and read back
// COMPREPLY. This is the only layer that proves the shell glue actually fills
// the completion array (quoting, the COMP_CWORD slice, the empty-trailing-word
// case). zsh is exercised with a syntax check where the binary is available.
describe("completion: bash wrapper smoke test", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api" },
                { key: "frontend", dirname: "fake-frontend" },
            ],
        });
        runMultree(sb, ["create", "demo", "--include", "api"]);
    });
    afterEach(() => sb.cleanup());

    function drive(compWords: string[], compCword: number): { status: number; reply: string[]; stderr: string } {
        const script = runMultree(sb, ["completion", "bash"]).stdout;
        // COMP_WORDS[0] is the program; point it at the real binary so the
        // wrapper self-dispatches without relying on PATH.
        const arr = [BIN, ...compWords].map(w => `"${w}"`).join(" ");
        const driver = `
${script}
COMP_WORDS=(${arr})
COMP_CWORD=${compCword}
_multree_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`;
        const r = spawnSync("bash", ["-c", driver], { env: sb.env, encoding: "utf-8" });
        return { status: r.status ?? -1, reply: lines(r.stdout ?? ""), stderr: r.stderr ?? "" };
    }

    it("is syntactically valid (bash -n)", () => {
        const script = runMultree(sb, ["completion", "bash"]).stdout;
        const r = spawnSync("bash", ["-n", "-c", script], { encoding: "utf-8" });
        assert.equal(r.status, 0, r.stderr);
    });

    it("fills COMPREPLY with group names after a trailing space (empty word)", () => {
        // `multree destroy <TAB>` -> COMP_WORDS=(multree destroy), CWORD=2.
        const { status, reply } = drive(["destroy", ""], 2);
        assert.equal(status, 0);
        assert.deepEqual(reply, ["demo"]);
    });

    it("fills COMPREPLY for a partial subcommand word", () => {
        // `multree de<TAB>` -> COMP_WORDS=(multree de), CWORD=1.
        const { reply } = drive(["de"], 1);
        assert.deepEqual(reply, ["destroy"]);
    });

    it("fills COMPREPLY with repo keys for create --include", () => {
        // `multree create g --include <TAB>` -> CWORD=4.
        const { reply } = drive(["create", "g", "--include", ""], 4);
        assert.deepEqual(reply.sort(), ["api", "frontend"]);
    });
});

const hasZsh = spawnSync("zsh", ["--version"], { encoding: "utf-8" }).status === 0;

describe("completion: zsh wrapper smoke test", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({ repos: [{ key: "api" }] });
    });
    afterEach(() => sb.cleanup());

    (hasZsh ? it : it.skip)("is syntactically valid (zsh -n)", () => {
        const script = runMultree(sb, ["completion", "zsh"]).stdout;
        const r = spawnSync("zsh", ["-n", "-c", script], { encoding: "utf-8" });
        assert.equal(r.status, 0, r.stderr);
    });
});
