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

test("shouldPrime always primes once a request needs two calls", () => {
  const saved = config.primeMinTokens;
  try {
    // Default: prime for any shared prefix, however short. There is no length
    // below which caching stops working, so there is no length to gate on.
    config.primeMinTokens = 0;
    expect(shouldPrime(1, 500)).toBe(false); // single question: nothing to share
    expect(shouldPrime(2, 1)).toBe(true); // the triage case, 66 tokens, primes
    expect(shouldPrime(6, 66)).toBe(true);
    expect(shouldPrime(6, 2268)).toBe(true);

    // A positive value is only a deliberate floor, not the default policy.
    config.primeMinTokens = 128;
    expect(shouldPrime(6, 127)).toBe(false);
    expect(shouldPrime(6, 128)).toBe(true);

    // Negative is the explicit off switch.
    config.primeMinTokens = -1;
    expect(shouldPrime(6, 100_000)).toBe(false);
  } finally {
    config.primeMinTokens = saved;
  }
});
