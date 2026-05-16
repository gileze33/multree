import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, type Sandbox } from "../helpers/sandbox.ts";

describe("show", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [{ key: "api", dirname: "fake-api" }],
        });
    });
    afterEach(() => sb.cleanup());

    it("prints group state for an existing group", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        const r = runMultree(sb, ["show", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Group: g/);
        assert.match(r.stdout, /api/);
    });

    // Regression: showCommand used to call process.exit(1) directly, which
    // bypassed the main() error formatter. Now it throws like every other
    // command and main() prints the message.
    it("errors cleanly when the group does not exist", () => {
        const r = runMultree(sb, ["show", "never-created"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Group not found: never-created/);
    });
});
