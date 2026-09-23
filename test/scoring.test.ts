import { test, expect } from "bun:test";
import { surfaceForms } from "../src/options.ts";
import { temperatureScale } from "../src/primitives.ts";

test("surfaceForms covers spacing and case", () => {
  expect(new Set(surfaceForms("yes"))).toEqual(new Set(["yes", " yes", "Yes", " Yes"]));
});

test("surfaceForms handles a leading-space option", () => {
  expect(new Set(surfaceForms(" positive"))).toEqual(
    new Set([" positive", "positive", " Positive", "Positive"]),
  );
});

test("surfaceForms can skip case variants", () => {
  expect(new Set(surfaceForms("yes", false))).toEqual(new Set(["yes", " yes"]));
});

test("temperatureScale sharpens and preserves order", () => {
  const sharp = temperatureScale({ a: 0.9, b: 0.1 }, 0.5);
  expect(sharp.a!).toBeGreaterThan(0.9);
  expect(sharp.a! + sharp.b!).toBeCloseTo(1, 10);
});

test("temperatureScale is identity at T=1", () => {
  const p = { a: 0.3, b: 0.7 };
  expect(temperatureScale(p, 1)).toEqual(p);
});
