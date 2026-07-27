import assert from "node:assert/strict";
import test from "node:test";
import { cover } from "../lib/memtree.js";

test("cover tiles every requested history within its hard budget", () => {
  for (let total = 1; total <= 10_000; total += 1) {
    for (const budget of [8, 16, 32, 64]) {
      const blocks = cover(total, budget);
      assert.ok(
        blocks.length <= budget,
        `cover(${total}, ${budget}) emitted ${blocks.length} blocks`
      );
      assert.equal(blocks[0].lo, 0);
      assert.equal(blocks.at(-1).hi, total);
      for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        assert.ok(current.hi > current.lo);
        assert.equal(current.size, current.hi - current.lo);
        assert.ok((current.level & (current.level - 1)) === 0);
        if (index > 0) {
          assert.equal(blocks[index - 1].hi, current.lo);
        }
      }
    }
  }
});

test("cover preserves full recent detail and spends available slack", () => {
  for (const budget of [8, 16, 32, 64]) {
    const blocks = cover(10_000, budget);
    assert.equal(blocks.length, budget);
    assert.equal(blocks.at(-1).size, 1);
  }
});

test("cover rejects invalid bounds", () => {
  assert.throws(() => cover(0, 8), /total must be an integer/u);
  assert.throws(() => cover(1, 0), /budget must be an integer/u);
  assert.throws(() => cover(10_000_001, 8), /total must be an integer/u);
});
