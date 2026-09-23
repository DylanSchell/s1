import { test, expect } from "bun:test";
import { commonPrefixLength, shouldPrime } from "../src/prefix.ts";
import { config } from "../src/config.ts";

test("commonPrefixLength needs at least two sequences", () => {
  expect(commonPrefixLength([])).toBe(0);
  expect(commonPrefixLength([[1, 2, 3]])).toBe(0);
});

test("commonPrefixLength finds the shared head", () => {
  expect(commonPrefixLength([[1, 2, 3], [1, 2, 4]])).toBe(2);
  expect(commonPrefixLength([[1, 2, 3], [1, 2, 3]])).toBe(3);
  expect(commonPrefixLength([[1, 2, 3], [4, 5, 6]])).toBe(0);
});

test("commonPrefixLength is bounded by the shortest sequence", () => {
  expect(commonPrefixLength([[1, 2], [1, 2, 3, 4]])).toBe(2);
});

test("commonPrefixLength is a prefix of all inputs", () => {
  const all = [[7, 8, 9, 1], [7, 8, 9, 2], [7, 8, 0]];
  expect(commonPrefixLength(all)).toBe(2);
});

test("shouldPrime requires two questions and a long enough prefix", () => {
  const saved = config.primeMinTokens;
  try {
    config.primeMinTokens = 128;
    expect(shouldPrime(1, 500)).toBe(false); // single question: nothing to share
    expect(shouldPrime(6, 127)).toBe(false);
    expect(shouldPrime(6, 128)).toBe(true);
    expect(shouldPrime(2, 2268)).toBe(true);

    config.primeMinTokens = 0; // explicit off switch
    expect(shouldPrime(6, 100_000)).toBe(false);
  } finally {
    config.primeMinTokens = saved;
  }
});
