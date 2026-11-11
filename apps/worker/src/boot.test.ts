import { describe, expect, it } from "vitest";
import { guardProcess, jsonLogger, survivable } from "./boot.ts";

function guarded() {
  const lines: Array<Record<string, unknown>> = [];
  const exits: number[] = [];
  let listener: (e: unknown, origin: string) => void = () => {};
  guardProcess(jsonLogger((l) => void lines.push(JSON.parse(l) as Record<string, unknown>)), {
    on: (_event, l) => void (listener = l),
    exit: (code) => void exits.push(code),
  });
  return { lines, exits, raise: (e: unknown, origin = "uncaughtException") => listener(e, origin) };
}

describe("the worker's last word on an uncaught error", () => {
  it("survives a dropped connection, and logs it", () => {
    const g = guarded();
    g.raise(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    g.raise(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01", severity: "FATAL" }));
    g.raise(new Error("Connection terminated unexpectedly"), "unhandledRejection");
    expect(g.exits).toEqual([]);
    expect(g.lines).toHaveLength(3);
    expect(g.lines[0]).toMatchObject({ level: "error", error: "ECONNRESET: read ECONNRESET", origin: "uncaughtException" });
    expect(g.lines[2]).toMatchObject({ origin: "unhandledRejection" });
  });

  it("stops on anything else, with the cause as the last line", () => {
    for (const e of [new TypeError("x is not a function"), new RangeError("Maximum call stack size exceeded"), Object.assign(new Error("no space"), { code: "ENOSPC" }), "a thrown string", null]) {
      const g = guarded();
      g.raise(e);
      expect(g.exits, String(e)).toEqual([1]);
      expect(g.lines.at(-1)!.msg).toMatch(/^worker stopping on an uncaught error: /);
    }
    expect(survivable(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
  });
});
