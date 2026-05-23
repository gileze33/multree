import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { terminalTitleSequence } from "../../src/tools.ts";

const ESC = "";
const BEL = "";

describe("terminalTitleSequence", () => {
    it("wraps the title in an OSC 0 set-title sequence terminated by BEL", () => {
        assert.equal(terminalTitleSequence("claude: my-group"), `${ESC}]0;claude: my-group${BEL}`);
    });
});
