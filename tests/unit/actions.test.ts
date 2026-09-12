import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { collectActionVerbs, resolveAction } from "../../src/actions.ts";
import type { GroupState, MemberState, MultreeConfig } from "../../src/types.ts";

function config(): MultreeConfig {
    return {
        version: 1,
        repos: {
            web: {
                path: "/src/web",
                commands: {
                    team: { cwd: "packages/team", run: "yarn dev", build: "yarn build" },
                    members: {
                        cwd: "packages/members",
                        run: { command: "yarn dev", cwd: "packages/members/app" },
                    },
                    root: { run: "yarn dev" },
                },
            },
            api: {
                path: "/src/api",
                commands: {
                    api: { run: "go run ." },
                },
            },
        },
    };
}

function member(repo: string, path: string): MemberState {
    return { repo, path, exposes: {} };
}

function group(members: Record<string, MemberState>): GroupState {
    return { name: "g", branch: "b", created_at: "t", members };
}

const WEB = group({ web: member("web", "/wt/web") });
const WEB_AND_API = group({ web: member("web", "/wt/web"), api: member("api", "/wt/api") });
const API_ONLY = group({ api: member("api", "/wt/api") });

describe("collectActionVerbs", () => {
    it("unions every action key across all repos, ignoring cwd", () => {
        assert.deepEqual([...collectActionVerbs(config())].sort(), ["build", "run"]);
    });

    it("is empty when no repo declares commands", () => {
        const verbs = collectActionVerbs({ version: 1, repos: { api: { path: "/x" } } });
        assert.equal(verbs.size, 0);
    });
});

describe("resolveAction", () => {
    it("resolves a target's action under its cwd subdir", () => {
        const r = resolveAction(config(), WEB, "run", "team");
        assert.deepEqual(r, {
            repo: "web",
            target: "team",
            action: "run",
            command: "yarn dev",
            cwd: "/wt/web/packages/team",
        });
    });

    it("lets an action-level cwd override the target cwd", () => {
        const r = resolveAction(config(), WEB, "run", "members");
        assert.equal(r.command, "yarn dev");
        assert.equal(r.cwd, "/wt/web/packages/members/app");
    });

    it("runs at the worktree root when no cwd is set", () => {
        assert.equal(resolveAction(config(), WEB, "run", "root").cwd, "/wt/web");
    });

    it("resolves a non-run verb the same way", () => {
        assert.equal(resolveAction(config(), WEB, "build", "team").command, "yarn build");
    });

    it("throws for an unknown target, listing what is available", () => {
        assert.throws(
            () => resolveAction(config(), WEB, "run", "ghost"),
            /No target "ghost".*Available for "run": members, root, team/s,
        );
    });

    it("ignores targets whose owning repo is not in the group", () => {
        assert.throws(() => resolveAction(config(), API_ONLY, "run", "team"), /No target "team"/);
    });

    it("throws when the target has no such action, listing its actions", () => {
        assert.throws(
            () => resolveAction(config(), WEB, "build", "members"),
            /has no action "build". Available: run/,
        );
    });

    it("throws when a target name is defined by two member repos", () => {
        const dup: MultreeConfig = {
            version: 1,
            repos: {
                web: { path: "/src/web", commands: { dup: { run: "a" } } },
                api: { path: "/src/api", commands: { dup: { run: "b" } } },
            },
        };
        assert.throws(
            () => resolveAction(dup, WEB_AND_API, "run", "dup"),
            /defined by more than one member.*rename one/s,
        );
    });
});

describe("resolveAction (apps)", () => {
    function appCfg(): MultreeConfig {
        return {
            version: 1,
            repos: { api: { path: "/src/api", commands: { api: { run: "go run ." } } } },
            apps: {
                mc: {
                    run: "mc-serve",
                    commands: { logs: "mc-logs" },
                    env: { PORT: "{mc.http_port}" },
                },
            },
        };
    }
    const WITH_APP = group({ api: member("api", "/wt/api"), mc: member("mc", "/wt/mc") });

    it("resolves an app's run verb to its command, scratchpad cwd, and env template", () => {
        assert.deepEqual(resolveAction(appCfg(), WITH_APP, "run", "mc"), {
            repo: "mc",
            target: "mc",
            action: "run",
            command: "mc-serve",
            cwd: "/wt/mc",
            envTemplate: { PORT: "{mc.http_port}" },
        });
    });

    it("resolves an app's non-run command verb in the scratchpad", () => {
        const r = resolveAction(appCfg(), WITH_APP, "logs", "mc");
        assert.equal(r.command, "mc-logs");
        assert.equal(r.cwd, "/wt/mc");
    });

    it("throws when an app has no such verb, listing its verbs", () => {
        assert.throws(
            () => resolveAction(appCfg(), WITH_APP, "ghost", "mc"),
            /App "mc" has no action "ghost"\. Available: logs, run/,
        );
    });

    it("ignores an app target when the app is not a member of the group", () => {
        assert.throws(() => resolveAction(appCfg(), API_ONLY, "run", "mc"), /No target "mc"/);
    });

    it("throws when a repo command target and an app share a name", () => {
        const dup: MultreeConfig = {
            version: 1,
            repos: { web: { path: "/src/web", commands: { mc: { run: "repo-cmd" } } } },
            apps: { mc: { run: "app-cmd" } },
        };
        const g = group({ web: member("web", "/wt/web"), mc: member("mc", "/wt/mc") });
        assert.throws(
            () => resolveAction(dup, g, "run", "mc"),
            /defined by more than one member.*rename one/s,
        );
    });
});
