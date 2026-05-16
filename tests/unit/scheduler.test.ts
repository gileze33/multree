import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runScheduled, topoOrder } from "../../src/scheduler.ts";

describe("topoOrder", () => {
    it("returns items unchanged when there are no deps", () => {
        assert.deepEqual(topoOrder(["a", "b", "c"], {}), ["a", "b", "c"]);
    });

    it("places dependencies before dependents", () => {
        const out = topoOrder(["frontend", "api"], { frontend: ["api"] });
        assert.deepEqual(out, ["api", "frontend"]);
    });

    it("handles a longer chain", () => {
        const out = topoOrder(["c", "b", "a"], { c: ["b"], b: ["a"] });
        assert.deepEqual(out, ["a", "b", "c"]);
    });

    it("throws on a direct cycle", () => {
        assert.throws(
            () => topoOrder(["a", "b"], { a: ["b"], b: ["a"] }),
            /Dependency cycle/,
        );
    });

    it("throws on an indirect cycle", () => {
        assert.throws(
            () => topoOrder(["a", "b", "c"], { a: ["b"], b: ["c"], c: ["a"] }),
            /Dependency cycle/,
        );
    });

    it("ignores deps that aren't in the item set", () => {
        assert.deepEqual(topoOrder(["a"], { a: ["external"] }), ["a"]);
    });
});

describe("runScheduled", () => {
    it("returns immediately on an empty item list", async () => {
        const results = await runScheduled([], async () => {}, { jobs: 4 });
        assert.deepEqual(results, []);
    });

    it("runs every item exactly once", async () => {
        const ran: string[] = [];
        const results = await runScheduled(["a", "b", "c"], async k => {
            ran.push(k);
        }, { jobs: 2 });
        ran.sort();
        assert.deepEqual(ran, ["a", "b", "c"]);
        assert.equal(results.length, 3);
        assert.ok(results.every(r => r.outcome === "ok"));
    });

    it("respects depends_on ordering even with jobs > 1", async () => {
        const ran: string[] = [];
        await runScheduled(["b", "a"], async k => {
            // 'a' must finish before 'b' starts; assert observed order.
            await new Promise(r => setTimeout(r, 10));
            ran.push(k);
        }, { jobs: 4, depsOf: { b: ["a"] } });
        assert.deepEqual(ran, ["a", "b"]);
    });

    it("respects jobs cap: never more than N in flight at once", async () => {
        let inFlight = 0;
        let peak = 0;
        await runScheduled(
            ["a", "b", "c", "d", "e", "f"],
            async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise(r => setTimeout(r, 30));
                inFlight--;
            },
            { jobs: 2 },
        );
        assert.equal(peak, 2);
    });

    it("runs independent tasks concurrently when jobs allow", async () => {
        const start = Date.now();
        await runScheduled(
            ["a", "b"],
            async () => {
                await new Promise(r => setTimeout(r, 80));
            },
            { jobs: 2 },
        );
        const elapsed = Date.now() - start;
        // Both tasks should overlap; total should be closer to one task's
        // duration than to two. Generous bound to avoid CI flakiness.
        assert.ok(elapsed < 140, `expected <140ms, got ${elapsed}ms`);
    });

    it("skips dependents of a failed task", async () => {
        const ran: string[] = [];
        const results = await runScheduled(
            ["a", "b", "c"],
            async k => {
                ran.push(k);
                if (k === "a") {
                    throw new Error("nope");
                }
            },
            { jobs: 1, depsOf: { b: ["a"] } },
        );
        assert.ok(!ran.includes("b"), "b should not have run");
        const byKey = new Map(results.map(r => [r.key, r]));
        assert.equal(byKey.get("a")!.outcome, "failed");
        assert.equal(byKey.get("b")!.outcome, "skipped");
        // 'c' has no dep on 'a', but the fail-fast policy stops it being
        // launched after 'a' fails.
        assert.equal(byKey.get("c")!.outcome, "skipped");
    });

    it("captures durations roughly", async () => {
        const results = await runScheduled(
            ["a"],
            async () => {
                await new Promise(r => setTimeout(r, 25));
            },
            { jobs: 1 },
        );
        assert.ok(results[0].durationMs >= 20, `got ${results[0].durationMs}ms`);
    });
});
