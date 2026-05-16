import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// Exercises a manifest shape closer to real-world usage: one producer with a
// dynamic exposed port, plus several consumers with differently-shaped
// consumes blocks — a single env file, a private-suffixed URL, and a monorepo
// consumer that writes managed blocks into multiple per-package env files.

describe("multi-shape consumers", () => {
    let sb: Sandbox;

    beforeEach(() => {
        sb = createSandbox({
            repos: [
                {
                    key: "core-api",
                    dirname: "fake-core-api",
                    setup: trace("core:setup", `echo "API_PORT=6789" > .env.local`),
                    teardown: trace("core:teardown"),
                    exposes: {
                        port: { type: "env_file", file: ".env.local", key: "API_PORT" },
                    },
                    defaults: { port: 5000 },
                },
                {
                    key: "simple-client",
                    dirname: "fake-simple",
                    setup: trace("simple:setup"),
                    files: { ".env": "EXISTING=keep\n" },
                    consumes: {
                        file: ".env",
                        upsert: { API_URL: "http://localhost:{core-api.port}" },
                    },
                },
                {
                    key: "admin-client",
                    dirname: "fake-admin",
                    setup: trace("admin:setup"),
                    files: { ".env": "" },
                    consumes: {
                        file: ".env",
                        upsert: {
                            PRIVATE_API: "http://localhost:{core-api.port}/private",
                        },
                    },
                },
                {
                    key: "web-suite",
                    dirname: "fake-web-suite",
                    setup: trace("web:setup"),
                    files: {
                        "packages/north/.env": "PKG=north\n",
                        "packages/south/.env": "PKG=south\n",
                        "packages/east/.env": "PKG=east\n",
                    },
                    consumes: [
                        {
                            file: "packages/north/.env",
                            upsert: { API_URL: "http://localhost:{core-api.port}" },
                        },
                        {
                            file: "packages/south/.env",
                            upsert: { API_URL: "http://localhost:{core-api.port}" },
                        },
                        {
                            file: "packages/east/.env",
                            upsert: { API_URL: "http://localhost:{core-api.port}" },
                        },
                    ],
                },
            ],
        });
    });
    afterEach(() => sb.cleanup());

    it("wires every consumer shape against the producer's exposed port", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "core-api,simple-client,admin-client,web-suite",
        ]);
        assert.equal(r.status, 0, r.stderr);

        const simple = readFileSync(join(sb.worktreePath("g", "simple-client"), ".env"), "utf-8");
        assert.match(simple, /EXISTING=keep/);
        assert.match(simple, /API_URL=http:\/\/localhost:6789/);

        const admin = readFileSync(join(sb.worktreePath("g", "admin-client"), ".env"), "utf-8");
        assert.match(admin, /PRIVATE_API=http:\/\/localhost:6789\/private/);

        // Each monorepo package gets its own managed block; none of the others is touched.
        const wsRoot = sb.worktreePath("g", "web-suite");
        for (const pkg of ["north", "south", "east"]) {
            const envPath = join(wsRoot, "packages", pkg, ".env");
            const content = readFileSync(envPath, "utf-8");
            assert.match(content, new RegExp(`PKG=${pkg}`), `${pkg} lost its existing content`);
            assert.match(content, /API_URL=http:\/\/localhost:6789/);
            assert.match(content, /# >>> multree-managed: g >>>/);
        }
    });

    it("without the producer, every consumer falls back to defaults", () => {
        const r = runMultree(sb, [
            "create",
            "g",
            "--include",
            "simple-client,admin-client,web-suite",
        ]);
        assert.equal(r.status, 0, r.stderr);

        const simple = readFileSync(join(sb.worktreePath("g", "simple-client"), ".env"), "utf-8");
        assert.match(simple, /API_URL=http:\/\/localhost:5000/);

        const admin = readFileSync(join(sb.worktreePath("g", "admin-client"), ".env"), "utf-8");
        assert.match(admin, /PRIVATE_API=http:\/\/localhost:5000\/private/);

        const wsRoot = sb.worktreePath("g", "web-suite");
        for (const pkg of ["north", "south", "east"]) {
            const content = readFileSync(join(wsRoot, "packages", pkg, ".env"), "utf-8");
            assert.match(content, /API_URL=http:\/\/localhost:5000/);
        }
    });

    it("re-wires every consumer when the producer is added later", () => {
        runMultree(sb, ["create", "g", "--include", "simple-client,web-suite"]);

        const before = readFileSync(join(sb.worktreePath("g", "simple-client"), ".env"), "utf-8");
        assert.match(before, /API_URL=http:\/\/localhost:5000/);

        const r = runMultree(sb, ["add", "g", "core-api"]);
        assert.equal(r.status, 0, r.stderr);

        const after = readFileSync(join(sb.worktreePath("g", "simple-client"), ".env"), "utf-8");
        assert.match(after, /API_URL=http:\/\/localhost:6789/);

        // Each monorepo package re-wires too.
        const wsRoot = sb.worktreePath("g", "web-suite");
        for (const pkg of ["north", "south", "east"]) {
            const content = readFileSync(join(wsRoot, "packages", pkg, ".env"), "utf-8");
            assert.match(content, /API_URL=http:\/\/localhost:6789/);
        }
    });

    it("removing the producer reverts every consumer to defaults", () => {
        runMultree(sb, ["create", "g", "--include", "core-api,simple-client,admin-client,web-suite"]);

        const r = runMultree(sb, ["remove", "g", "core-api"]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(sb.trace().includes("core:teardown"));
        assert.equal(existsSync(sb.worktreePath("g", "core-api")), false);

        const simple = readFileSync(join(sb.worktreePath("g", "simple-client"), ".env"), "utf-8");
        assert.match(simple, /API_URL=http:\/\/localhost:5000/);

        const wsRoot = sb.worktreePath("g", "web-suite");
        for (const pkg of ["north", "south", "east"]) {
            const content = readFileSync(join(wsRoot, "packages", pkg, ".env"), "utf-8");
            assert.match(content, /API_URL=http:\/\/localhost:5000/);
        }
    });
});
