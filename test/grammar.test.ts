import { test, expect } from "bun:test";
import { alternationGrammar, alternationOfPaths, escapeGbnf, literalGrammar, tokenRef, tokenSequence } from "../src/grammar.ts";

test("escapeGbnf escapes quotes, backslashes and newlines", () => {
  expect(escapeGbnf('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
});

test("literalGrammar pins a single continuation", () => {
  expect(literalGrammar(" yes")).toBe('root ::= " yes"');
});

test("alternationGrammar joins options", () => {
  expect(alternationGrammar(["yes", "no"])).toBe('root ::= "yes" | "no"');
});

test("tokenRef emits the GBNF token primitive", () => {
  expect(tokenRef(1546)).toBe("<[1546]>");
});

test("tokenSequence joins token ids", () => {
  expect(tokenSequence([1546, 6572])).toBe("<[1546]> <[6572]>");
});

test("alternationOfPaths builds a token-level alternation", () => {
  expect(alternationOfPaths([[1546, 6572], [20002]])).toBe(
    "<[1546]> <[6572]> | <[20002]>",
  );
});

test("alternationOfPaths rejects empty input", () => {
  expect(() => alternationOfPaths([])).toThrow();
});
