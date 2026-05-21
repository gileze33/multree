import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import type { MultreeConfig } from "../../src/types.ts";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// Integration coverage for ${VAR} expansion in the two manifest path fields
// that support it: worktree_root and repos[*].path. Everything else (hook
// command strings, prime_artifacts paths, tools commands, etc.) is asserted
// to NOT be expanded — i.e. those fields stay literal so the shell can handle
// any expansion at execution time.

// Rewrites the sandbox manifest to use ${BASE_VAR} as a placeholder for the
// concrete absolute path prefix in worktree_root and each repo's path. The
// concrete prefix is the sandbox root that both already live under, so once
// the env var is set to that root, paths resolve back to where the fixtures
// actually are. Returns the prefix for the test to export into env.
function rewriteManifestToUseEnvVar(
    manifestPath: string,
    baseVarName: string,
): string {
    const cfg = parse(readFileSync(manifestPath, "utf-8")) as MultreeConfig;
    const root = cfg.worktree_root!;
    // Both worktree_root and every repo path live under the sandbox root by
    // construction (createSandbox puts repos-default/ and worktree-default/
    // siblings under the same tmpdir). Strip the worktree-default suffix to
    // get the common parent.
    const prefix = root.replace(/\/worktree-[^/]+$/, "");
    cfg.worktree_root = root.replace(prefix, `\${${baseVarName}}`);
    for (const repo of Object.values(cfg.repos)) {
        repo.path = repo.path.replace(prefix, `\${${baseVarName}}`);
    }
    writeFileSync(manifestPath, stringify(cfg));
    return prefix;
}

describe("manifest env var expansion", () => {
    const BASE_VAR = "MULTREE_TEST_INTEG_BASE";
    let sb: Sandbox;
    let prefix: string;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    setup: trace("api:setup"),
                },
            ],
        });
        prefix = rewriteManifestToUseEnvVar(sb.manifestPath, BASE_VAR);
    });
    afterEach(() => sb.cleanup());

    it("resolves ${VAR} in worktree_root and repos[*].path when the env var is set", () => {
        const env = { ...sb.env, [BASE_VAR]: prefix };
        const r = runMultree({ env }, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, `create failed:\n${r.stderr}`);

        // The worktree should land at the original (pre-rewrite) location,
        // proving the placeholder was substituted to the env var's value.
        assert.ok(existsSync(sb.worktreePath("g", "api")));
        const state = sb.state("g");
        assert.ok(state, "expected group state to exist");
        assert.equal(state!.name, "g");
    });

    it("fails loudly when ${VAR} is referenced but the env var is unset", () => {
        const env = { ...sb.env };
        delete env[BASE_VAR];
        const r = runMultree({ env }, ["list"]);
        assert.notEqual(r.status, 0, "expected non-zero exit when env var is missing");
        // Error must identify the offending var by name; silent fallthrough
        // would be the dangerous case.
        assert.match(r.stderr, new RegExp(BASE_VAR));
        assert.match(r.stderr, /unset or empty/);
        // No stack trace — main() prints err.message and exits 1.
        assert.doesNotMatch(r.stderr, /at .*config\.ts/);
    });

    it("fails loudly when ${VAR} is referenced but the env var is empty", () => {
        // The whole point of treating empty string as undefined: a path like
        // `${BASE}/code/api` with BASE="" would otherwise silently become
        // `/code/api` and point operations at the wrong filesystem location.
        const env = { ...sb.env, [BASE_VAR]: "" };
        const r = runMultree({ env }, ["list"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, new RegExp(BASE_VAR));
        assert.match(r.stderr, /unset or empty/);
    });

    it("fails loudly on a syntactically invalid placeholder", () => {
        // Hand-craft a manifest with a malformed ${} so the regex rejects it
        // at expansion time. This guards against any future loosening of the
        // name validation regex letting odd characters through.
        const cfg = parse(readFileSync(sb.manifestPath, "utf-8")) as MultreeConfig;
        cfg.worktree_root = `\${BAD NAME}/x`;
        writeFileSync(sb.manifestPath, stringify(cfg));

        const r = runMultree(sb, ["list"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Invalid env var name "BAD NAME"/);
    });
});

describe("manifest env var expansion does not bleed into other fields", () => {
    // Negative-coverage suite: confirms that expandPath()'s env handling is
    // scoped to the two intended fields and doesn't accidentally process other
    // strings (hook commands, tool commands, etc.). A safety net against
    // future refactors that might centralise expansion in the wrong place.
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "api",
                    dirname: "fake-api",
                    // The setup hook references an env var that is deliberately
                    // NOT set in the test env. If multree were eagerly expanding
                    // env vars in hook command strings at config-load time,
                    // this would throw before the hook ever ran. We want the
                    // literal `${UNSET_AT_LOAD_TIME}` to be passed through to
                    // the shell, which substitutes it as empty string at hook
                    // execution time — same as any other shell-run command.
                    setup: "echo \"got: ${UNSET_AT_LOAD_TIME}\" > /dev/null",
                },
            ],
            tools: {
                // Same shape on the tool side: a tool command should not be
                // touched by config-load expansion either.
                noop: { command: "echo ${UNSET_AT_LOAD_TIME}", open_in: "$root" },
            },
        });
    });
    afterEach(() => sb.cleanup());

    it("does not expand ${VAR} inside hook command strings at config load time", () => {
        // If hook command strings were being passed through expandPath, this
        // create call would fail with our "unset or empty" error before
        // anything ran. Success here means the literal made it through to the
        // shell at hook execution time.
        const env = { ...sb.env };
        delete env.UNSET_AT_LOAD_TIME;
        const r = runMultree({ env }, ["create", "g", "--include", "api"]);
        assert.equal(r.status, 0, `create failed:\n${r.stderr}`);
    });

    it("does not expand ${VAR} inside tool command strings at config load time", () => {
        const env = { ...sb.env };
        delete env.UNSET_AT_LOAD_TIME;
        const create = runMultree({ env }, ["create", "g", "--include", "api"]);
        assert.equal(create.status, 0, `create failed:\n${create.stderr}`);
        const tool = runMultree({ env }, ["noop", "g"]);
        assert.equal(tool.status, 0, `tool dispatch failed:\n${tool.stderr}`);
    });
});
