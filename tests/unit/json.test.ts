import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readMcpServers, writeGroupMcpJson, writeGroupSettingsJson } from "../../src/json.ts";

describe("writeGroupMcpJson", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-json-"));
        path = join(dir, ".mcp.json");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const read = (): Record<string, unknown> => JSON.parse(readFileSync(path, "utf-8"));

    it("writes owned servers under mcpServers and returns their names", () => {
        const owned = writeGroupMcpJson(
            path,
            { postloop: { type: "http", url: "http://localhost:8200/mcp" } },
            [],
        );
        assert.deepEqual(owned, ["postloop"]);
        assert.deepEqual(read().mcpServers, {
            postloop: { type: "http", url: "http://localhost:8200/mcp" },
        });
    });

    it("updates an owned server in place on a re-run", () => {
        writeGroupMcpJson(path, { postloop: { type: "http", url: "http://localhost:8200/mcp" } }, []);
        writeGroupMcpJson(
            path,
            { postloop: { type: "http", url: "http://localhost:8201/mcp" } },
            ["postloop"],
        );
        assert.equal(
            (read().mcpServers as Record<string, { url: string }>).postloop.url,
            "http://localhost:8201/mcp",
        );
    });

    it("removes a previously-owned server that is no longer produced", () => {
        writeGroupMcpJson(
            path,
            { a: { type: "http", url: "http://a" }, b: { type: "http", url: "http://b" } },
            [],
        );
        const owned = writeGroupMcpJson(path, { a: { type: "http", url: "http://a" } }, ["a", "b"]);
        assert.deepEqual(owned, ["a"]);
        assert.deepEqual(Object.keys(read().mcpServers as object), ["a"]);
    });

    it("preserves foreign mcpServers entries and sibling keys", () => {
        writeFileSync(
            path,
            JSON.stringify({
                mcpServers: { handwritten: { type: "http", url: "http://kept" } },
                someOtherKey: { keep: true },
            }),
        );
        writeGroupMcpJson(path, { postloop: { type: "http", url: "http://localhost/mcp" } }, []);
        const doc = read();
        assert.deepEqual(doc.someOtherKey, { keep: true });
        const servers = doc.mcpServers as Record<string, unknown>;
        assert.ok(servers.handwritten, "foreign server dropped");
        assert.ok(servers.postloop, "owned server missing");
    });

    it("does not delete a foreign server when removing owned ones", () => {
        writeFileSync(path, JSON.stringify({ mcpServers: { handwritten: { type: "http", url: "http://kept" } } }));
        writeGroupMcpJson(path, { owned: { type: "http", url: "http://o" } }, []);
        writeGroupMcpJson(path, {}, ["owned"]);
        const servers = read().mcpServers as Record<string, unknown>;
        assert.deepEqual(Object.keys(servers), ["handwritten"]);
    });

    it("removes the file entirely when nothing is left", () => {
        writeGroupMcpJson(path, { only: { type: "http", url: "http://o" } }, []);
        assert.ok(existsSync(path));
        const owned = writeGroupMcpJson(path, {}, ["only"]);
        assert.deepEqual(owned, []);
        assert.equal(existsSync(path), false);
    });

    it("no-ops (creates nothing) when there are no servers and no file", () => {
        const owned = writeGroupMcpJson(path, {}, []);
        assert.deepEqual(owned, []);
        assert.equal(existsSync(path), false);
    });
});

describe("writeGroupSettingsJson", () => {
    let dir: string;
    let spath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-settings-"));
        spath = join(dir, ".claude", "settings.json");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const read = (): Record<string, unknown> => JSON.parse(readFileSync(spath, "utf-8"));

    it("writes additionalDirectories under permissions and creates the .claude dir", () => {
        const owned = writeGroupSettingsJson(spath, ["/wt/a", "/wt/b"], []);
        assert.deepEqual(owned, ["/wt/a", "/wt/b"]);
        assert.deepEqual((read().permissions as { additionalDirectories: string[] }).additionalDirectories, [
            "/wt/a",
            "/wt/b",
        ]);
    });

    it("syncs the owned set on re-run (adds new, drops gone)", () => {
        writeGroupSettingsJson(spath, ["/wt/a", "/wt/b"], []);
        writeGroupSettingsJson(spath, ["/wt/a", "/wt/c"], ["/wt/a", "/wt/b"]);
        const dirs = (read().permissions as { additionalDirectories: string[] }).additionalDirectories;
        assert.deepEqual([...dirs].sort(), ["/wt/a", "/wt/c"]);
    });

    it("preserves foreign additionalDirectories and sibling keys", () => {
        mkdirSync(dirname(spath), { recursive: true });
        writeFileSync(
            spath,
            JSON.stringify({
                permissions: { additionalDirectories: ["/outside"], allow: ["Bash(ls)"] },
                model: "x",
            }),
        );
        writeGroupSettingsJson(spath, ["/wt/a"], []);
        const doc = read();
        assert.equal(doc.model, "x");
        const perms = doc.permissions as { additionalDirectories: string[]; allow: string[] };
        assert.deepEqual(perms.allow, ["Bash(ls)"]);
        assert.ok(perms.additionalDirectories.includes("/outside"), "foreign dir dropped");
        assert.ok(perms.additionalDirectories.includes("/wt/a"), "owned dir missing");
    });

    it("removes the file when nothing is left", () => {
        writeGroupSettingsJson(spath, ["/wt/a"], []);
        assert.ok(existsSync(spath));
        const owned = writeGroupSettingsJson(spath, [], ["/wt/a"]);
        assert.deepEqual(owned, []);
        assert.equal(existsSync(spath), false);
    });
});

describe("readMcpServers", () => {
    let dir: string;
    let mpath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-readmcp-"));
        mpath = join(dir, ".mcp.json");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("returns the mcpServers map", () => {
        writeFileSync(mpath, JSON.stringify({ mcpServers: { foo: { type: "http", url: "http://x" } } }));
        assert.deepEqual(readMcpServers(mpath), { foo: { type: "http", url: "http://x" } });
    });

    it("returns null for a missing file", () => {
        assert.equal(readMcpServers(mpath), null);
    });

    it("returns null for an unparseable file", () => {
        writeFileSync(mpath, "{ not json");
        assert.equal(readMcpServers(mpath), null);
    });

    it("returns null when there is no mcpServers key", () => {
        writeFileSync(mpath, JSON.stringify({ other: true }));
        assert.equal(readMcpServers(mpath), null);
    });
});
