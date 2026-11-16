import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cooldownMs, rotate, switchesKey, uniqueKeys } from "@/lib/ai/key-ring";

describe("AI key loop", () => {
  it("keeps one copy of each key and the single key first", () => {
    assert.deepEqual(uniqueKeys("key-a", "key-b, key-a, key-c"), ["key-a", "key-b", "key-c"]);
    assert.deepEqual(uniqueKeys("", "  key-b\nkey-c  "), ["key-b", "key-c"]);
  });

  it("starts at the next key and wraps back to the first", () => {
    assert.deepEqual(rotate(["or-1", "or-2", "groq-1"], 1), ["or-2", "groq-1", "or-1"]);
    assert.deepEqual(rotate(["or-1", "or-2", "groq-1"], 3), ["or-1", "or-2", "groq-1"]);
  });

  it("moves on when a key is out of credit, limited, or rejected", () => {
    assert.equal(switchesKey("CREDITS", "out of credits"), true);
    assert.equal(switchesKey("RATE_LIMIT", "slow down"), true);
    assert.equal(switchesKey("AUTH", "invalid"), true);
    assert.equal(switchesKey("BAD_REQUEST", "You requested up to 4000 tokens, but can only afford 968"), true);
    assert.equal(switchesKey("MALFORMED", "not json"), false);
  });

  it("cools a spent key long enough for the others to run", () => {
    assert.equal(cooldownMs("CREDITS"), 10 * 60_000);
    assert.equal(cooldownMs("RATE_LIMIT", 5_000), 5_000);
  });
});
