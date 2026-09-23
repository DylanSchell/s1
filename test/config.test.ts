import { test, expect } from "bun:test";
import { CliError, applyCli, config, parseCli } from "../src/config.ts";

test("parseCli accepts long, short and =-joined forms", () => {
  const a = parseCli(["--base-url", "http://x:1", "--model", "m"]);
  expect(a.values["base-url"]).toBe("http://x:1");
  expect(a.values.model).toBe("m");

  const b = parseCli(["-u", "http://x:1", "-m", "m"]);
  expect(b.values["base-url"]).toBe("http://x:1");
  expect(b.values.model).toBe("m");

  const c = parseCli(["--base-url=http://x:1", "--model=m"]);
  expect(c.values["base-url"]).toBe("http://x:1");
  expect(c.values.model).toBe("m");
});

test("parseCli reports --help and rejects unknown flags", () => {
  expect(parseCli(["--help"]).help).toBe(true);
  expect(parseCli(["-h"]).help).toBe(true);
  expect(() => parseCli(["--nope"])).toThrow(CliError);
  expect(() => parseCli(["positional"])).toThrow(CliError);
});

test("applyCli overrides config and normalizes the base URL", () => {
  const saved = { ...config };
  try {
    applyCli({ "base-url": "http://host:1234/", model: "custom", port: "9000" });
    expect(config.baseUrl).toBe("http://host:1234");
    expect(config.model).toBe("custom");
    expect(config.port).toBe(9000);
  } finally {
    Object.assign(config, saved);
  }
});

test("applyCli rejects non-positive numbers", () => {
  const saved = { ...config };
  try {
    expect(() => applyCli({ port: "abc" })).toThrow(CliError);
    expect(() => applyCli({ concurrency: "0" })).toThrow(CliError);
    expect(() => applyCli({ "timeout-ms": "-5" })).toThrow(CliError);
    // A rejected value must not have partially applied.
    expect(config.port).toBe(saved.port);
  } finally {
    Object.assign(config, saved);
  }
});
