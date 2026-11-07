// New app kept Continue live while a branch change was being read, when the last read had filled in a
// port. A quick Continue then saved the old branch's Dockerfile builder. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsForRead } from "../components/new-app/read-wait.ts";

const base = { picked: true, branch: "main", port: "", edited: false, detect: "idle" };

test("the first read holds Continue", () => {
  assert.equal(waitsForRead(base), true);
  assert.equal(waitsForRead({ ...base, detect: "loading" }), true);
});

test("a port filled in by the last read does not let a branch change go on", () => {
  assert.equal(waitsForRead({ ...base, port: "3000", detect: "idle" }), true);
  assert.equal(waitsForRead({ ...base, port: "3000", detect: "loading" }), true);
});

test("a port the operator typed goes ahead, as before", () => {
  assert.equal(waitsForRead({ ...base, port: "8080", edited: true, detect: "loading" }), false);
});

test("a finished or failed read never holds it, and nor does an empty branch or no repository", () => {
  assert.equal(waitsForRead({ ...base, detect: "done" }), false);
  assert.equal(waitsForRead({ ...base, detect: "error" }), false);
  assert.equal(waitsForRead({ ...base, branch: " ", detect: "idle" }), false);
  assert.equal(waitsForRead({ ...base, picked: false }), false);
});
