import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// --plan: a dry run that prints the schedule without touching disk.
describe("create --plan", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", install: "echo ignored" },
                { key: "frontend", dirname: "fake-frontend", dependsOn: ["api"] },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("prints a plan and exits without creating anything", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api,frontend", "--plan"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Plan for create "g"/);
        assert.match(r.stdout, /Phase prime/);
        assert.match(r.stdout, /Phase install/);
        assert.match(r.stdout, /Phase setup/);
        // depends_on should surface in the setup plan section.
        assert.match(r.stdout, /\[frontend\].*after: api/);
        // No state and no worktree directories should be created.
        assert.equal(sb.state("g"), null);
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
    });
});

// --jobs + parallel_setup: two slow setup hooks should overlap.
describe("create --jobs with parallel_setup", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            parallelSetup: true,
            repos: [
                { key: "a", dirname: "fake-a", setup: trace("a:setup", "sleep 0.4") },
                { key: "b", dirname: "fake-b", setup: trace("b:setup", "sleep 0.4") },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("overlapping setups complete in roughly one slot, not two", () => {
        const start = Date.now();
        const r = runMultree(sb, ["create", "g", "--include", "a,b", "--jobs", "2"]);
        const elapsed = Date.now() - start;
        assert.equal(r.status, 0, r.stderr);
        // Each setup sleeps 0.4s; serial would be 0.8s+overhead. With jobs=2
        // and parallel_setup, total spawn-to-exit should be well under 0.7s
        // wall-clock for the setup phase alone. Allow generous slack for the
        // surrounding fetch+worktree work and CI variance.
        assert.ok(elapsed < 3000, `expected <3000ms total, got ${elapsed}ms`);
        const events = sb.trace();
        assert.ok(events.includes("a:setup"));
        assert.ok(events.includes("b:setup"));
    });
});

// depends_on ordering must hold even when setup runs in parallel.
describe("create with depends_on", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            parallelSetup: true,
            repos: [
                { key: "api", dirname: "fake-api", setup: trace("api:setup", "sleep 0.2") },
                {
                    key: "frontend",
                    dirname: "fake-frontend",
                    dependsOn: ["api"],
                    setup: trace("frontend:setup"),
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("frontend's setup runs only after api's setup finishes", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api,frontend", "--jobs", "4"]);
        assert.equal(r.status, 0, r.stderr);
        const events = sb.trace();
        const apiIdx = events.indexOf("api:setup");
        const frontendIdx = events.indexOf("frontend:setup");
        assert.ok(apiIdx >= 0 && frontendIdx >= 0, `missing events: ${events.join(",")}`);
        assert.ok(
            apiIdx < frontendIdx,
            `expected api before frontend, got: ${events.join(",")}`,
        );
    });
});

// Per-repo hook timeout fails the run with a timeout-shaped error.
describe("create with hook timeout", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "slow",
                    dirname: "fake-slow",
                    hookTimeout: "200ms",
                    setup: "sleep 5",
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("kills the hook and surfaces a timeout error", () => {
        const start = Date.now();
        const r = runMultree(sb, ["create", "g", "--include", "slow"]);
        const elapsed = Date.now() - start;
        assert.notEqual(r.status, 0);
        // Should fail fast: total time well under the 5s sleep.
        assert.ok(elapsed < 4000, `expected <4000ms (killed early), got ${elapsed}ms`);
        const combined = `${r.stdout}\n${r.stderr}`;
        assert.match(combined, /timed out/i);
    });
});

// --resume: re-running create after a setup failure should skip already-done
// phases and re-execute the failed phase.
describe("create --resume", () => {
    let sb: Sandbox;

    // Hook that fails the first time and succeeds thereafter. Uses the trace
    // log path as a sandbox-scoped sentinel so it self-cleans with the
    // sandbox temp dir.
    const flakyHook =
        `if [ -f "$MULTREE_TEST_LOG.sentinel" ]; then ` +
            `echo "flaky:retry-ok" >> "$MULTREE_TEST_LOG"; exit 0; ` +
        "else " +
            `echo "flaky:first-fail" >> "$MULTREE_TEST_LOG"; ` +
            `touch "$MULTREE_TEST_LOG.sentinel"; exit 1; ` +
        "fi";

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", setup: trace("api:setup") },
                { key: "flaky", dirname: "fake-flaky", setup: flakyHook },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("first run fails, second run with --resume completes without re-running done phases", () => {
        const r1 = runMultree(sb, ["create", "g", "--include", "api,flaky"]);
        assert.notEqual(r1.status, 0, "first run should have failed");

        const state1 = sb.state("g");
        assert.equal(state1?.members.api.phase_status?.setup, "done");
        assert.equal(state1?.members.flaky.phase_status?.setup, "failed");

        const r2 = runMultree(sb, ["create", "g", "--include", "api,flaky", "--resume"]);
        assert.equal(r2.status, 0, `resume failed:\n${r2.stderr}`);

        const state2 = sb.state("g");
        assert.equal(state2?.members.flaky.phase_status?.setup, "done");

        // api:setup ran exactly once (skipped on resume); flaky ran twice
        // and the two runs left distinguishable events.
        const events = sb.trace();
        assert.equal(
            events.filter(e => e === "api:setup").length,
            1,
            `api:setup ran ${events.filter(e => e === "api:setup").length} times`,
        );
        assert.ok(events.includes("flaky:first-fail"));
        assert.ok(events.includes("flaky:retry-ok"));
    });

    it("rejects --resume when there is no existing group to resume", () => {
        const r = runMultree(sb, ["create", "fresh", "--include", "api", "--resume"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /no existing group/);
    });
});

// --verbose streams hook stdout to the parent process.
describe("create --verbose", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "noisy",
                    dirname: "fake-noisy",
                    setup: "echo MULTREE_VERBOSE_MARKER_XYZ",
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("streams hook stdout with a per-repo prefix when --verbose is set", () => {
        const r = runMultree(sb, ["create", "v1", "--include", "noisy", "--verbose"]);
        assert.equal(r.status, 0, r.stderr);
        // Live-streamed output is prefixed with `[<repo>] ` -- this prefix
        // only appears when verbose was on; the unprefixed marker would also
        // appear in non-verbose output because we echo the hook command.
        assert.match(r.stdout, /\[noisy\] MULTREE_VERBOSE_MARKER_XYZ/);
    });

    it("suppresses captured hook stdout on success without --verbose", () => {
        const r = runMultree(sb, ["create", "v2", "--include", "noisy"]);
        assert.equal(r.status, 0, r.stderr);
        // The hook's own output should not be surfaced -- only the printed
        // command line (which doesn't carry the [noisy] prefix).
        assert.doesNotMatch(r.stdout, /\[noisy\] MULTREE_VERBOSE_MARKER_XYZ/);
    });
});

// On a non-verbose hook failure the captured output is dumped to stderr so
// the user can see *why* the hook failed without re-running with --verbose.
// This is a regression net for the runMemberHook helper.
describe("create hook failure output", () => {
    let sb: Sandbox;
    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "noisy",
                    dirname: "fake-noisy",
                    setup: "echo HOOK_STDOUT_FAIL_MARKER; echo HOOK_STDERR_FAIL_MARKER >&2; exit 1",
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("surfaces captured stdout+stderr on stderr when a non-verbose hook fails", () => {
        const r = runMultree(sb, ["create", "g", "--include", "noisy"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /HOOK_STDOUT_FAIL_MARKER/);
        assert.match(r.stderr, /HOOK_STDERR_FAIL_MARKER/);
    });
});
