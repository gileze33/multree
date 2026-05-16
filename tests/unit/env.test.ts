import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseEnvFile, removeManagedBlock, upsertManagedBlock } from "../../src/env.ts";

describe("parseEnvFile", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-env-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("returns empty object when file doesn't exist", () => {
        assert.deepEqual(parseEnvFile(join(dir, "missing")), {});
    });

    it("parses simple KEY=VALUE", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "FOO=bar\nBAZ=qux\n");
        assert.deepEqual(parseEnvFile(f), { FOO: "bar", BAZ: "qux" });
    });

    it("strips matching surrounding quotes", () => {
        const f = join(dir, ".env");
        writeFileSync(f, `FOO="bar"\nBAZ='qux'\n`);
        assert.deepEqual(parseEnvFile(f), { FOO: "bar", BAZ: "qux" });
    });

    it("ignores comments and blank lines", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "# header\n\nFOO=bar\n# trailing\n");
        assert.deepEqual(parseEnvFile(f), { FOO: "bar" });
    });

    it("ignores malformed lines", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "not a kv\nFOO=bar\n=missingkey\n");
        assert.deepEqual(parseEnvFile(f), { FOO: "bar" });
    });
});

describe("upsertManagedBlock", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-env-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("writes a managed block into a fresh file", () => {
        const f = join(dir, ".env");
        upsertManagedBlock(f, { API_URL: "http://localhost:5100" }, "group1");
        const content = readFileSync(f, "utf-8");
        assert.match(content, /# >>> multree-managed: group1 >>>/);
        assert.match(content, /API_URL=http:\/\/localhost:5100/);
        assert.match(content, /# <<< multree-managed: group1 <<</);
    });

    it("preserves existing user content before the block", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "USER_VAR=keep\n");
        upsertManagedBlock(f, { API_URL: "x" }, "g");
        const content = readFileSync(f, "utf-8");
        assert.match(content, /USER_VAR=keep/);
        assert.match(content, /API_URL=x/);
    });

    it("is idempotent across repeated calls", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "USER_VAR=keep\n");
        upsertManagedBlock(f, { API_URL: "x" }, "g");
        const first = readFileSync(f, "utf-8");
        upsertManagedBlock(f, { API_URL: "x" }, "g");
        const second = readFileSync(f, "utf-8");
        assert.equal(first, second);
    });

    it("updates values on subsequent calls without duplicating the block", () => {
        const f = join(dir, ".env");
        upsertManagedBlock(f, { API_URL: "old" }, "g");
        upsertManagedBlock(f, { API_URL: "new" }, "g");
        const content = readFileSync(f, "utf-8");
        const blockCount = (content.match(/multree-managed: g start|multree-managed: g >>>/g) ?? []).length;
        assert.equal(blockCount, 1);
        assert.match(content, /API_URL=new/);
        assert.doesNotMatch(content, /API_URL=old/);
    });

    it("does not interfere with another group's block in the same file", () => {
        const f = join(dir, ".env");
        upsertManagedBlock(f, { API_URL: "for-a" }, "groupA");
        upsertManagedBlock(f, { API_URL: "for-b" }, "groupB");
        const content = readFileSync(f, "utf-8");
        assert.match(content, /multree-managed: groupA/);
        assert.match(content, /multree-managed: groupB/);
        assert.match(content, /API_URL=for-a/);
        assert.match(content, /API_URL=for-b/);
    });
});

describe("removeManagedBlock", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "multree-env-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("strips a managed block leaving user content intact", () => {
        const f = join(dir, ".env");
        writeFileSync(f, "USER=keep\n");
        upsertManagedBlock(f, { API_URL: "x" }, "g");
        removeManagedBlock(f, "g");
        const content = readFileSync(f, "utf-8");
        assert.match(content, /USER=keep/);
        assert.doesNotMatch(content, /multree-managed/);
        assert.doesNotMatch(content, /API_URL/);
    });

    it("is a no-op when the file doesn't exist", () => {
        removeManagedBlock(join(dir, "missing"), "g");
    });
});
