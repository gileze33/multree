import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { terminalTitleSequence } from "../../src/tools.ts";

const ESC = "";
const BEL = "";

describe("terminalTitleSequence", () => {
    it("wraps the title in an OSC 0 set-title sequence terminated by BEL", () => {
        assert.equal(terminalTitleSequence("my-group"), `${ESC}]0;my-group${BEL}`);
    });

    it("preserves dotted and hyphenated group names verbatim", () => {
        assert.equal(terminalTitleSequence("feat.x-2"), `${ESC}]0;feat.x-2${BEL}`);
    });
});
