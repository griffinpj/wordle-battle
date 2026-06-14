const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  score,
  isFormatOk,
  isInLocalList,
  randomAnswer,
  ANSWERS,
  validSetSize,
} = require("../words");

test("isFormatOk requires lowercase a-z, length 5", () => {
  assert.equal(isFormatOk("crane"), true);
  assert.equal(isFormatOk("CRANE"), false);
  assert.equal(isFormatOk("cran"), false);
  assert.equal(isFormatOk("cranes"), false);
  assert.equal(isFormatOk("cran3"), false);
  assert.equal(isFormatOk(""), false);
  assert.equal(isFormatOk(null), false);
  assert.equal(isFormatOk(undefined), false);
});

test("isInLocalList finds common 5-letter words", () => {
  assert.equal(isInLocalList("crane"), true);
  assert.equal(isInLocalList("apple"), true);
  // a deliberately bogus combination unlikely to be in the corpus
  assert.equal(isInLocalList("zzzzz"), false);
});

test("validSetSize is much larger than the curated answer list", () => {
  assert.ok(validSetSize > 5000, `expected >5000 valid guesses, got ${validSetSize}`);
  assert.ok(ANSWERS.length > 100);
});

test("randomAnswer always returns a valid 5-letter answer", () => {
  for (let i = 0; i < 50; i++) {
    const w = randomAnswer();
    assert.equal(typeof w, "string");
    assert.equal(w.length, 5);
    assert.ok(ANSWERS.includes(w));
  }
});

test("score: all-correct produces five greens", () => {
  assert.deepEqual(score("crane", "crane"), [
    "correct", "correct", "correct", "correct", "correct",
  ]);
});

test("score: all-absent produces five greys", () => {
  assert.deepEqual(score("aaaaa", "bcdef"), [
    "absent", "absent", "absent", "absent", "absent",
  ]);
});

test("score: mixed greens, yellows, and greys", () => {
  // target=crate, guess=crane => c,r,a are correct; n absent; e correct.
  assert.deepEqual(score("crane", "crate"), [
    "correct", "correct", "correct", "absent", "correct",
  ]);
});

test("score: duplicate letters in guess handled correctly", () => {
  // target=apple (a,p,p,l,e), guess=allee (a,l,l,e,e)
  // Greens first: pos 0 a==a, pos 4 e==e. Remaining target pool: p,p,l.
  // pos 1 l vs p: l in pool -> present (consume l). pool: p,p.
  // pos 2 l vs p: l not in pool -> absent.
  // pos 3 e vs l: e not in pool -> absent.
  assert.deepEqual(score("allee", "apple"), [
    "correct", "present", "absent", "absent", "correct",
  ]);
});

test("score: yellow only counted once when target has one occurrence", () => {
  // target=robot, guess=ooooo
  // letters in target: r,o,b,o,t. matches: pos 1 o == o correct; pos 3 o == o correct.
  // For non-matched positions of guess (0,2,4) all o, but tCounts after greens
  // removes both o's so all other o's are absent.
  assert.deepEqual(score("ooooo", "robot"), [
    "absent", "correct", "absent", "correct", "absent",
  ]);
});
