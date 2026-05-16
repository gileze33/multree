import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("push", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                { key: "api", dirname: "fake-api", withRemote: true },
                { key: "frontend", dirname: "fake-frontend", withRemote: true },
                { key: "readonly", dirname: "fake-ro", withRemote: true, push: false },
            ],
        });
    });

    afterEach(() => sb.cleanup());

    it("pushes each member's branch to origin (and sets upstream on first push)", () => {
        runMultree(sb, ["create", "g", "--include", "api,frontend"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /✓ api \(multree\/g\)/);
        assert.match(r.stdout, /✓ frontend \(multree\/g\)/);

        assert.ok(sb.remoteHasBranch("api", "multree/g"));
        assert.ok(sb.remoteHasBranch("frontend", "multree/g"));
    });

    it("skips repos with push: false", () => {
        runMultree(sb, ["create", "g", "--include", "api,readonly"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /readonly: skipped \(push: false\)/);
        assert.match(r.stdout, /✓ api/);
        assert.equal(sb.remoteHasBranch("readonly", "multree/g"), false);
    });

    it("reports a non-zero exit when any push fails", () => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" /* no remote */ }],
        });
        runMultree(sb, ["create", "g", "--include", "api"]);

        const r = runMultree(sb, ["push", "g"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stdout, /✗ api: push failed/);
    });
});
