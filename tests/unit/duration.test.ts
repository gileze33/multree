import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatDuration, parseDuration } from "../../src/duration.ts";

describe("parseDuration", () => {
    it("treats a bare number as seconds", () => {
        assert.equal(parseDuration(5), 5000);
    });

    it("treats a bare numeric string as seconds", () => {
        assert.equal(parseDuration("300"), 300_000);
    });

    it("parses the ms suffix", () => {
        assert.equal(parseDuration("500ms"), 500);
    });

    it("parses the s suffix", () => {
        assert.equal(parseDuration("30s"), 30_000);
    });

    it("parses the m suffix", () => {
        assert.equal(parseDuration("5m"), 300_000);
    });

    it("parses the h suffix", () => {
        assert.equal(parseDuration("2h"), 7_200_000);
    });

    it("tolerates whitespace", () => {
        assert.equal(parseDuration("  10s  "), 10_000);
    });

    it("accepts decimal values", () => {
        assert.equal(parseDuration("1.5s"), 1500);
    });

    it("rejects negative numbers", () => {
        assert.throws(() => parseDuration(-1), /Invalid duration/);
    });

    it("rejects an empty string", () => {
        assert.throws(() => parseDuration(""), /Invalid duration/);
    });

    it("rejects garbage", () => {
        assert.throws(() => parseDuration("soon"), /Invalid duration/);
        assert.throws(() => parseDuration("5x"), /Invalid duration/);
    });
});

describe("formatDuration", () => {
    it("prints ms below 1 second", () => {
        assert.equal(formatDuration(750), "750ms");
    });

    it("prints decimal seconds under a minute", () => {
        assert.equal(formatDuration(1500), "1.50s");
    });

    it("prints minutes + seconds beyond a minute", () => {
        assert.equal(formatDuration(65_000), "1m5.0s");
    });
});
