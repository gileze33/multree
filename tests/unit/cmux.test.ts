import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildLayout, resolveGroupTarget, shouldOpenCmux, type LayoutNode, type PaneNode } from "../../src/cmux.ts";
import type { CmuxConfig, GroupState, MemberState, MultreeConfig } from "../../src/types.ts";

function config(cmux?: CmuxConfig, tools?: MultreeConfig["tools"]): MultreeConfig {
    return {
        version: 1,
        worktree_root: "/wt",
        repos: {
            api: { path: "/src/api", commands: { api: { run: "pnpm develop" } } },
            web: {
                path: "/src/web",
                commands: { team: { run: "pnpm develop" }, members: { run: "pnpm develop" } },
            },
            rn: { path: "/src/rn" }, // no run targets -> shell by default
        },
        ...(tools ? { tools } : {}),
        ...(cmux ? { cmux } : {}),
    };
}

function member(repo: string, path: string): MemberState {
    return { repo, path, exposes: {} };
}

function group(members: Record<string, MemberState>): GroupState {
    return { name: "g", branch: "b", created_at: "t", members };
}

const FULL = group({
    api: member("api", "/wt/g/api"),
    web: member("web", "/wt/g/web"),
    rn: member("rn", "/wt/g/rn"),
});

// Leaf panes in render order, flattening the split tree.
function leaves(node: LayoutNode): PaneNode[] {
    return "pane" in node ? [node] : node.children.flatMap(leaves);
}

function commands(node: LayoutNode): (string | undefined)[] {
    return leaves(node).map(p => p.pane.surfaces[0].command);
}

describe("buildLayout", () => {
    it("defaults to a service pane per run target and a shell for repos with none", () => {
        const { layout, root, panes } = buildLayout(config(), FULL);
        assert.equal(root, "/wt/g");
        assert.deepEqual(panes, ["claude", "api (api)", "team (web)", "members (web)", "rn (shell)"]);
        assert.deepEqual(commands(layout), [
            "claude",
            "multree run g api",
            "multree run g team",
            "multree run g members",
            undefined, // rn shell pane carries a cwd, not a command
        ]);
    });

    it("puts claude in a left horizontal split at the default 0.5", () => {
        const { layout } = buildLayout(config(), FULL);
        assert.ok(!("pane" in layout));
        assert.equal(layout.direction, "horizontal");
        assert.equal(layout.split, 0.5);
        assert.equal((layout.children[0] as PaneNode).pane.surfaces[0].command, "claude");
    });

    it("gives a shell pane the repo worktree cwd and no command", () => {
        const rnPane = leaves(buildLayout(config(), FULL).layout).at(-1)!;
        assert.deepEqual(rnPane.pane.surfaces[0], { type: "terminal", cwd: "/wt/g/rn" });
    });

    it("honours cmux.split", () => {
        const { layout } = buildLayout(config({ split: 0.3 }), FULL);
        assert.equal((layout as Exclude<LayoutNode, PaneNode>).split, 0.3);
    });

    it("honours cmux.claude as a string and an argv array", () => {
        assert.equal(commands(buildLayout(config({ claude: "claude --resume" }), FULL).layout)[0], "claude --resume");
        assert.equal(commands(buildLayout(config({ claude: ["claude", "--x"] }), FULL).layout)[0], "claude --x");
    });

    it("falls back to the claude tool command when cmux.claude is unset", () => {
        const cfg = config(undefined, { claude: { command: "claude-code" } });
        assert.equal(commands(buildLayout(cfg, FULL).layout)[0], "claude-code");
    });

    it("lets a panes override beat the default (service repo forced to shell)", () => {
        const { layout, panes } = buildLayout(config({ panes: { api: "shell" } }), FULL);
        assert.deepEqual(panes, ["claude", "api (shell)", "team (web)", "members (web)", "rn (shell)"]);
        const apiPane = leaves(layout)[1];
        assert.deepEqual(apiPane.pane.surfaces[0], { type: "terminal", cwd: "/wt/g/api" });
    });

    it("skips a repo entirely when told to", () => {
        const { panes } = buildLayout(config({ panes: { web: "skip" } }), FULL);
        assert.deepEqual(panes, ["claude", "api (api)", "rn (shell)"]);
    });

    it("emits both a service and a shell pane for an array override", () => {
        const { panes } = buildLayout(config({ panes: { api: ["service", "shell"] } }), FULL);
        assert.deepEqual(panes, ["claude", "api (api)", "api (shell)", "team (web)", "members (web)", "rn (shell)"]);
    });

    it("collapses to a lone claude pane when nothing populates the right stack", () => {
        const { layout, panes } = buildLayout(config({ panes: { api: "skip", web: "skip", rn: "skip" } }), FULL);
        assert.ok("pane" in layout);
        assert.deepEqual(panes, ["claude"]);
    });

    it("ignores repos that are not members of the group", () => {
        const { panes } = buildLayout(config(), group({ api: member("api", "/wt/g/api") }));
        assert.deepEqual(panes, ["claude", "api (api)"]);
    });
});

describe("shouldOpenCmux", () => {
    const SAVED = process.env.CMUX_SOCKET_PATH;
    beforeEach(() => {
        delete process.env.CMUX_SOCKET_PATH;
    });
    afterEach(() => {
        if (SAVED === undefined) {
            delete process.env.CMUX_SOCKET_PATH;
        } else {
            process.env.CMUX_SOCKET_PATH = SAVED;
        }
    });

    it("the --cmux/--no-cmux override wins over everything", () => {
        assert.equal(shouldOpenCmux(config(), true), true);
        assert.equal(shouldOpenCmux(config({ auto: true }), false), false);
    });

    it("cmux.auto decides when there is no override", () => {
        assert.equal(shouldOpenCmux(config({ auto: true })), true); // even outside cmux
        process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
        assert.equal(shouldOpenCmux(config({ auto: false })), false); // even inside cmux
    });

    it("defaults to on only when a cmux block exists and we are inside cmux", () => {
        assert.equal(shouldOpenCmux(config({})), false); // block present, but outside cmux
        process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
        assert.equal(shouldOpenCmux(config({})), true); // block present and inside cmux
        assert.equal(shouldOpenCmux(config()), false); // no block at all
    });
});

describe("resolveGroupTarget", () => {
    it("defaults to the caller's current group when unset", () => {
        assert.deepEqual(resolveGroupTarget(config()), { kind: "current" });
        assert.deepEqual(resolveGroupTarget(config({})), { kind: "current" });
    });

    it("reads the config keywords and names", () => {
        assert.deepEqual(resolveGroupTarget(config({ group: "current" })), { kind: "current" });
        assert.deepEqual(resolveGroupTarget(config({ group: "none" })), { kind: "none" });
        assert.deepEqual(resolveGroupTarget(config({ group: "worktrees" })), {
            kind: "named",
            name: "worktrees",
        });
    });

    it("lets the override beat the config", () => {
        assert.deepEqual(resolveGroupTarget(config({ group: "worktrees" }), "none"), { kind: "none" });
        assert.deepEqual(resolveGroupTarget(config({ group: "none" }), "current"), { kind: "current" });
        assert.deepEqual(resolveGroupTarget(config({ group: "current" }), "other"), {
            kind: "named",
            name: "other",
        });
    });
});
