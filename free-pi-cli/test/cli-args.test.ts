import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseCliArgs, versionLine } from "../src/cli-args";
import { CLI_VERSION } from "../src/version";

describe("parseCliArgs — local command dispatch", () => {
  test("no args -> run in tui mode (the agent flow, unchanged default)", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run", mode: "tui" });
  });

  test.each([["--help"], ["-h"], ["help"]])( "%s -> help", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "help" });
  });

  test.each([["--version"], ["-v"]])( "%s -> version", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "version" });
  });

  test("logout -> logout", () => {
    expect(parseCliArgs(["logout"])).toEqual({ kind: "logout" });
  });

  test("unrecognized first arg -> unknown (a typo must not silently start a token-burning agent session)", () => {
    expect(parseCliArgs(["loguot"])).toEqual({ kind: "unknown", arg: "loguot" });
  });

  test("trailing args after a valid command -> unknown, reporting the extra arg", () => {
    expect(parseCliArgs(["logout", "--force"])).toEqual({ kind: "unknown", arg: "--force" });
  });
});

describe("parseCliArgs — run flags", () => {
  test("--mode rpc selects the headless protocol, in either position", () => {
    expect(parseCliArgs(["--mode", "rpc"])).toEqual({ kind: "run", mode: "rpc" });
    expect(parseCliArgs(["--session", "abc", "--mode", "rpc"])).toEqual({
      kind: "run",
      mode: "rpc",
      session: "abc",
    });
  });

  test("--mode tui is explicit and equivalent to the default", () => {
    expect(parseCliArgs(["--mode", "tui"])).toEqual({ kind: "run", mode: "tui" });
  });

  test("--session is accepted (the CLI's own resume hint prints this flag)", () => {
    expect(parseCliArgs(["--session", "01a12d0b-a86b-7163-b987-5909541569a1"])).toEqual({
      kind: "run",
      mode: "tui",
      session: "01a12d0b-a86b-7163-b987-5909541569a1",
    });
  });

  test("--session without a value -> unknown, never a fresh session", () => {
    expect(parseCliArgs(["--session"])).toEqual({ kind: "unknown", arg: "--session" });
    expect(parseCliArgs(["--session", "--mode", "rpc"])).toEqual({ kind: "unknown", arg: "--session" });
  });

  test("an unsupported --mode value -> unknown, never a silently different mode", () => {
    expect(parseCliArgs(["--mode", "json"])).toEqual({ kind: "unknown", arg: "json" });
    expect(parseCliArgs(["--mode"])).toEqual({ kind: "unknown", arg: "--mode" });
  });

  test("unknown run flags still fail loudly", () => {
    expect(parseCliArgs(["--yolo"])).toEqual({ kind: "unknown", arg: "--yolo" });
    expect(parseCliArgs(["--mode", "rpc", "--yolo"])).toEqual({ kind: "unknown", arg: "--yolo" });
  });
});

describe("help/version text", () => {
  test("help documents every command, the run flags and the env overrides", () => {
    for (const needle of [
      "logout",
      "--version",
      "--help",
      "--session",
      "--mode rpc",
      "FREEPI_BASE_URL",
      "FREEPI_NO_AUTO_UPDATE",
    ]) {
      expect(HELP_TEXT).toContain(needle);
    }
  });

  test("version line carries the real CLI_VERSION", () => {
    expect(versionLine()).toBe(`free-pi-cli ${CLI_VERSION}`);
  });
});
