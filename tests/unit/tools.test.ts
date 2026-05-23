import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { itermBadgeSequence, terminalTitleSequence } from "../../src/tools.ts";

const ESC = "";
const BEL = "";

describe("terminalTitleSequence", () => {
    it("wraps the title in an OSC 0 set-title sequence terminated by BEL", () => {
        assert.equal(terminalTitleSequence("claude: my-group"), `${ESC}]0;claude: my-group${BEL}`);
    });
});

describe("itermBadgeSequence", () => {
    it("base64-encodes the badge text in an OSC 1337 SetBadgeFormat sequence", () => {
        assert.equal(itermBadgeSequence("my-group"), `${ESC}]1337;SetBadgeFormat=bXktZ3JvdXA=${BEL}`);
    });
});
