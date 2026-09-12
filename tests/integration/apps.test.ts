import { strict as assert } from "node:assert";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runMultree } from "../helpers/cli.ts";
import { createSandbox, trace, type Sandbox } from "../helpers/sandbox.ts";

// api exposes a port and consumes the app's presence token + claimed smtp port,
// so its env changes only when the app is in the group. mailcatcher is an app
// (no git): two claimed ports, injected env, a run command that echoes its env,
// and an mcps entry that contributes to the group-root .mcp.json.
function sandbox(): Sandbox {
    return createSandbox({
        repos: [
            {
                key: "api",
                dirname: "fake-api",
                setup: trace("api:setup", `echo "API_PORT=5234" > .env.local`),
                teardown: trace("api:teardown"),
                exposes: { port: { type: "env_file", file: ".env.local", key: "API_PORT" } },
                defaults: { port: 5000 },
                consumes: {
                    file: ".env.local",
                    upsert: {
                        SMTP_ENABLED: "{mailcatcher.included}",
                        SMTP_PORT: "{mailcatcher.smtp_port}",
                    },
                },
            },
        ],
        apps: [
            {
                key: "mailcatcher",
                dependsOn: ["api"],
                variables: {
                    http_port: { type: "number", min: 8200, max: 8249, default: 8025 },
                    smtp_port: { type: "number", min: 1100, max: 1149, default: 1025 },
                },
                env: {
                    PORT: "{mailcatcher.http_port}",
                    SMTP_PORT: "{mailcatcher.smtp_port}",
                    RELAY: "http://localhost:{api.port}/inbound",
                },
                run: 'echo "RUN PORT=$PORT SMTP_PORT=$SMTP_PORT RELAY=$RELAY CWD=$(pwd)"',
                mcps: {
                    mailcatcher: {
                        type: "http",
                        url: "http://localhost:{mailcatcher.http_port}/mcp",
                    },
                },
            },
        ],
    });
}

function mcpJson(sb: Sandbox, group: string): Record<string, unknown> | null {
    const p = join(sb.worktreeRoot, group, ".mcp.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>) : null;
}

function mcpServers(sb: Sandbox, group: string): Record<string, { type?: string; url?: string }> {
    return (mcpJson(sb, group)?.mcpServers ?? {}) as Record<string, { type?: string; url?: string }>;
}

function settingsJson(sb: Sandbox, group: string): Record<string, unknown> | null {
    const p = join(sb.worktreeRoot, group, ".claude", "settings.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>) : null;
}

function additionalDirs(sb: Sandbox, group: string): string[] {
    const s = settingsJson(sb, group) as { permissions?: { additionalDirectories?: string[] } } | null;
    return s?.permissions?.additionalDirectories ?? [];
}

// Allocations the global ledger ($MULTREE_HOME/variables.json) holds for one
// member of one group.
function ledgerFor(sb: Sandbox, group: string, memberKey: string): Array<{ variable: string }> {
    const p = join(sb.home, "variables.json");
    if (!existsSync(p)) {
        return [];
    }
    const reg = JSON.parse(readFileSync(p, "utf-8")) as {
        allocations?: Array<{ group: string; repo: string; variable: string }>;
    };
    return (reg.allocations ?? []).filter(a => a.group === group && a.repo === memberKey);
}

describe("apps (create/run/wiring)", () => {
    let sb: Sandbox;
    beforeEach(() => (sb = sandbox()));
    afterEach(() => sb.cleanup());

    it("creates a scratchpad member, allocates ports, wires env, writes .mcp.json", () => {
        const r = runMultree(sb, ["create", "g", "--include", "api,mailcatcher"]);
        assert.equal(r.status, 0, `non-zero exit\n${r.stderr}`);

        const state = sb.state("g");
        assert.ok(state);
        const app = state!.members.mailcatcher;
        assert.ok(app, "app member missing from state");
        assert.equal(app.kind, "app");

        // Scratchpad exists at <root>/<group>/<app>, but no git worktree.
        const scratch = join(sb.worktreeRoot, "g", "mailcatcher");
        assert.equal(app.path, scratch);
        assert.ok(existsSync(scratch), "scratchpad dir missing");
        assert.equal(existsSync(join(scratch, ".git")), false, "app should not be a git worktree");

        // Ports allocated from the declared ranges.
        const httpPort = app.variables?.http_port;
        const smtpPort = app.variables?.smtp_port;
        assert.ok(httpPort && Number(httpPort) >= 8200 && Number(httpPort) <= 8249, httpPort);
        assert.ok(smtpPort && Number(smtpPort) >= 1100 && Number(smtpPort) <= 1149, smtpPort);

        // Group-root .mcp.json carries the app's server with the resolved url.
        assert.deepEqual(state!.mcp_servers, ["mailcatcher"]);
        const doc = mcpJson(sb, "g");
        assert.ok(doc, ".mcp.json missing");
        const servers = doc!.mcpServers as Record<string, { type: string; url: string }>;
        assert.equal(servers.mailcatcher.type, "http");
        assert.equal(servers.mailcatcher.url, `http://localhost:${httpPort}/mcp`);

        // api's env is gated ON: presence token true, smtp port = the app's claim.
        const apiEnv = readFileSync(join(sb.worktreePath("g", "api"), ".env.local"), "utf-8");
        assert.match(apiEnv, /SMTP_ENABLED=true/);
        assert.match(apiEnv, new RegExp(`SMTP_PORT=${smtpPort}`));
    });

    it("runs the app with its env injected, in the scratchpad", () => {
        runMultree(sb, ["create", "g", "--include", "api,mailcatcher"]);
        const app = sb.state("g")!.members.mailcatcher;
        const httpPort = app.variables?.http_port;

        const r = runMultree(sb, ["run", "g", "mailcatcher"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`RUN PORT=${httpPort} `));
        assert.match(r.stdout, /RELAY=http:\/\/localhost:5234\/inbound/);
    });

    it("lists the app as a run target", () => {
        runMultree(sb, ["create", "g", "--include", "api,mailcatcher"]);
        const r = runMultree(sb, ["run", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /run targets in "g": mailcatcher/);
    });

    it("leaves the consumer at defaults and writes no server when the app is absent", () => {
        const r = runMultree(sb, ["create", "solo", "--include", "api"]);
        assert.equal(r.status, 0, r.stderr);

        // Presence token resolves to "" (falsy); smtp port falls back to the
        // app variable's default (1025). api's behaviour is unchanged.
        const apiEnv = readFileSync(join(sb.worktreePath("solo", "api"), ".env.local"), "utf-8");
        assert.match(apiEnv, /SMTP_ENABLED=\n/);
        assert.match(apiEnv, /SMTP_PORT=1025/);

        // No member contributes mcps, so no group-root .mcp.json is created.
        assert.equal(mcpJson(sb, "solo"), null);
        assert.deepEqual(sb.state("solo")!.mcp_servers, []);
    });

    it("destroy removes the scratchpad, the .mcp.json, and frees the ports", () => {
        runMultree(sb, ["create", "g", "--include", "api,mailcatcher"]);
        const scratch = join(sb.worktreeRoot, "g", "mailcatcher");
        assert.ok(existsSync(scratch));
        // Both of the app's variables are allocated in the ledger before destroy.
        assert.equal(ledgerFor(sb, "g", "mailcatcher").length, 2);

        const r = runMultree(sb, ["destroy", "g"]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(existsSync(join(sb.worktreeRoot, "g")), false);
        assert.equal(sb.state("g"), null);
        // The app's ports are returned to the pool.
        assert.equal(ledgerFor(sb, "g", "mailcatcher").length, 0);
    });

    it("add then remove an app updates .mcp.json and cleans up the scratchpad", () => {
        runMultree(sb, ["create", "g", "--include", "api"]);
        assert.equal(mcpJson(sb, "g"), null);

        const added = runMultree(sb, ["add", "g", "mailcatcher"]);
        assert.equal(added.status, 0, added.stderr);
        const scratch = join(sb.worktreeRoot, "g", "mailcatcher");
        assert.ok(existsSync(scratch), "scratchpad not created on add");
        const afterAdd = mcpJson(sb, "g");
        assert.ok(afterAdd, ".mcp.json not written on add");
        assert.ok((afterAdd!.mcpServers as Record<string, unknown>).mailcatcher);
        // Ports are allocated in the ledger once the app is a member.
        assert.equal(ledgerFor(sb, "g", "mailcatcher").length, 2);

        const removed = runMultree(sb, ["remove", "g", "mailcatcher"]);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(scratch), false, "scratchpad not removed");
        // The app's server is gone; with no members left contributing, the file
        // is deleted entirely.
        assert.equal(mcpJson(sb, "g"), null);
        assert.equal(sb.state("g")!.members.mailcatcher, undefined);
        // The app's ports are freed on remove.
        assert.equal(ledgerFor(sb, "g", "mailcatcher").length, 0);
    });
});

describe("claude_workspace (hoist member mcps + additionalDirectories)", () => {
    // Two repos: one ships its own .mcp.json (to be hoisted), one does not.
    function wsSandbox(on: boolean): Sandbox {
        return createSandbox({
            repos: [
                {
                    key: "webby",
                    dirname: "fake-webby",
                    files: {
                        ".mcp.json": JSON.stringify({
                            mcpServers: { webby: { type: "http", url: "http://localhost:7000/mcp" } },
                        }),
                    },
                },
                { key: "apiish", dirname: "fake-apiish" },
            ],
            claudeWorkspace: on
                ? { hoist_member_mcps: true, additional_directories: true }
                : undefined,
        });
    }

    it("hoists member .mcp.json servers and lists member worktrees in settings.json", () => {
        const sb = wsSandbox(true);
        try {
            const r = runMultree(sb, ["create", "g", "--include", "webby,apiish"]);
            assert.equal(r.status, 0, r.stderr);

            // webby's own server is hoisted into the group-root .mcp.json.
            const doc = mcpJson(sb, "g");
            assert.ok(doc, ".mcp.json missing");
            const servers = doc!.mcpServers as Record<string, { url: string }>;
            assert.equal(servers.webby.url, "http://localhost:7000/mcp");
            assert.deepEqual(sb.state("g")!.mcp_servers, ["webby"]);

            // settings.json grants file access to both repo worktrees.
            const sp = join(sb.worktreeRoot, "g", ".claude", "settings.json");
            assert.ok(existsSync(sp), "settings.json missing");
            const perms = (
                JSON.parse(readFileSync(sp, "utf-8")) as {
                    permissions: { additionalDirectories: string[] };
                }
            ).permissions;
            assert.ok(
                perms.additionalDirectories.includes(sb.worktreePath("g", "webby")),
                "webby worktree missing from additionalDirectories",
            );
            assert.ok(
                perms.additionalDirectories.includes(sb.worktreePath("g", "apiish")),
                "apiish worktree missing from additionalDirectories",
            );
        } finally {
            sb.cleanup();
        }
    });

    it("does nothing when the flags are off", () => {
        const sb = wsSandbox(false);
        try {
            const r = runMultree(sb, ["create", "g", "--include", "webby,apiish"]);
            assert.equal(r.status, 0, r.stderr);
            // webby's own .mcp.json is NOT hoisted, and no settings.json is written.
            assert.equal(mcpJson(sb, "g"), null);
            assert.equal(existsSync(join(sb.worktreeRoot, "g", ".claude", "settings.json")), false);
        } finally {
            sb.cleanup();
        }
    });
});


describe("claude_workspace (hoist collision + member removal)", () => {
    it("manifest mcps wins over a hoisted member server of the same name", () => {
        const sb = createSandbox({
            repos: [
                {
                    key: "webby",
                    dirname: "fake-webby",
                    files: {
                        ".mcp.json": JSON.stringify({
                            mcpServers: { clash: { type: "http", url: "http://localhost:9999/mcp" } },
                        }),
                    },
                },
            ],
            apps: [
                {
                    key: "mc",
                    run: "x",
                    variables: { http_port: { type: "number", min: 8200, max: 8249, default: 8025 } },
                    mcps: { clash: { type: "http", url: "http://localhost:{mc.http_port}/mcp" } },
                },
            ],
            claudeWorkspace: { hoist_member_mcps: true, additional_directories: true },
        });
        try {
            const r = runMultree(sb, ["create", "g", "--include", "webby,mc"]);
            assert.equal(r.status, 0, r.stderr);
            const httpPort = sb.state("g")!.members.mc.variables?.http_port;
            // Manifest wins: the resolved app url (its claimed port), not :9999.
            assert.equal(mcpServers(sb, "g").clash.url, `http://localhost:${httpPort}/mcp`);
        } finally {
            sb.cleanup();
        }
    });

    it("drops a removed repo's hoisted server and additionalDirectory, keeping foreign entries", () => {
        const sb = createSandbox({
            repos: [
                {
                    key: "webby",
                    dirname: "fake-webby",
                    files: {
                        ".mcp.json": JSON.stringify({
                            mcpServers: { webby: { type: "http", url: "http://localhost:7000/mcp" } },
                        }),
                    },
                },
                { key: "apiish", dirname: "fake-apiish" },
            ],
            claudeWorkspace: { hoist_member_mcps: true, additional_directories: true },
        });
        try {
            runMultree(sb, ["create", "g", "--include", "webby,apiish"]);

            // Pre-seed foreign, hand-added entries that multree must preserve.
            const mcpPath = join(sb.worktreeRoot, "g", ".mcp.json");
            const doc = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
                mcpServers: Record<string, unknown>;
            };
            doc.mcpServers.foreign = { type: "http", url: "http://localhost:1/mcp" };
            writeFileSync(mcpPath, JSON.stringify(doc, null, 2));

            const spPath = join(sb.worktreeRoot, "g", ".claude", "settings.json");
            const sp = JSON.parse(readFileSync(spPath, "utf-8")) as {
                permissions: { additionalDirectories: string[] };
                foreignKey?: string;
            };
            sp.permissions.additionalDirectories.push("/foreign/dir");
            sp.foreignKey = "keep me";
            writeFileSync(spPath, JSON.stringify(sp, null, 2));

            const removed = runMultree(sb, ["remove", "g", "webby"]);
            assert.equal(removed.status, 0, removed.stderr);

            const servers = mcpServers(sb, "g");
            assert.equal(servers.webby, undefined, "removed repo's hoisted server still present");
            assert.ok(servers.foreign, "foreign server was clobbered");

            const dirs = additionalDirs(sb, "g");
            assert.equal(dirs.includes(sb.worktreePath("g", "webby")), false);
            assert.ok(dirs.includes(sb.worktreePath("g", "apiish")));
            assert.ok(dirs.includes("/foreign/dir"), "foreign dir was clobbered");
            assert.equal((settingsJson(sb, "g") as { foreignKey?: string }).foreignKey, "keep me");
        } finally {
            sb.cleanup();
        }
    });
});
