// The browser's half of the terminal protocol: held to the contracts file it copies from (the web has
// its own install and cannot import it), and to the rule that no ticket ever sits in a URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contentSecurityPolicy } from "../lib/security-headers.ts";
import { chunkBytes, clampSize, describeClose, MAX_PASTE_BYTES, PASTE_CHUNK_BYTES, TERMINAL_CLOSE, TERMINAL_IDLE_MINUTES, TERMINAL_TOTAL_MINUTES, terminalUrl } from "../lib/terminal.ts";

const contract = readFileSync(new URL("../../../packages/contracts/src/terminal.ts", import.meta.url), "utf8");

test("every close code matches the contract", () => {
  const block = /export const TERMINAL_CLOSE = \{([\s\S]*?)\} as const;/.exec(contract)[1];
  const theirs = Object.fromEntries([...block.matchAll(/^\s*(\w+): (\d+),$/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual({ ...TERMINAL_CLOSE }, theirs);
});

test("the limits the page promises match the contract", () => {
  assert.match(contract, /idleMs: 15 \* 60_000/);
  assert.match(contract, /totalMs: 60 \* 60_000/);
  assert.equal(TERMINAL_IDLE_MINUTES, 15);
  assert.equal(TERMINAL_TOTAL_MINUTES, 60);
  assert.match(contract, /maxMessageBytes: 64 \* 1024/);
  assert.match(contract, /inputBurstBytes: 512 \* 1024/);
  assert.ok(MAX_PASTE_BYTES <= 512 * 1024);
  assert.ok(PASTE_CHUNK_BYTES <= 64 * 1024);
});

test("the socket's address is same origin, by protocol, with no query", () => {
  assert.equal(terminalUrl({ protocol: "https:", host: "dash.example.com" }, "abc"), "wss://dash.example.com/api/v1/apps/abc/terminal");
  assert.equal(terminalUrl({ protocol: "http:", host: "127.0.0.1:3006" }, "abc"), "ws://127.0.0.1:3006/api/v1/apps/abc/terminal");
  assert.equal(terminalUrl({ protocol: "https:", host: "d" }, "a/../b?ticket=x"), "wss://d/api/v1/apps/a%2F..%2Fb%3Fticket%3Dx/terminal");
});

test("the view sends the ticket in a message and stores nothing", () => {
  const view = readFileSync(new URL("../components/app-detail/terminal-view.tsx", import.meta.url), "utf8");
  assert.match(view, /ws\.send\(JSON\.stringify\(\{ t: "auth", ticket,/);
  assert.doesNotMatch(view, /[?&]ticket=/);
  assert.doesNotMatch(view, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(view, /console\./);
  // Output of a hostile container: no clipboard addon, and a link in it opens nothing.
  assert.doesNotMatch(view, /addon-clipboard|addon-web-links/);
  assert.match(view, /linkHandler: \{ activate: \(\) => \{\} \}/);
  assert.match(view, /data-raw-keys/);
});

test("xterm loads only through the tab's dynamic import, and is pinned", () => {
  const tab = readFileSync(new URL("../components/app-detail/terminal-tab.tsx", import.meta.url), "utf8");
  assert.match(tab, /dynamic\(\(\) => import\("\.\/terminal-view"\)/);
  assert.doesNotMatch(tab, /from "@xterm/);
  assert.match(tab, /import type \{ TerminalHandle, ViewEvent \} from "\.\/terminal-view"/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.dependencies["@xterm/xterm"], /^\d+\.\d+\.\d+$/);
  assert.match(pkg.dependencies["@xterm/addon-fit"], /^\d+\.\d+\.\d+$/);
});

test("the production policy stays strict: no eval, and sockets only to this origin", () => {
  const csp = contentSecurityPolicy("n", false);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /connect-src 'self'(;|$)/);
});

test("every close reads as a sentence, and an unknown code as a dropped connection", () => {
  for (const code of Object.values(TERMINAL_CLOSE)) {
    const d = describeClose(code);
    assert.ok(d.title && d.body);
    assert.doesNotMatch(`${d.title}${d.body}`, /[\u2013\u2014]/);
  }
  assert.equal(describeClose(1006).title, "The connection dropped");
  assert.equal(describeClose(TERMINAL_CLOSE.noShell).retry, false);
  assert.equal(describeClose(1009).title, "Too much input at once");
});

test("a paste is cut under the socket's limit and nothing is lost", () => {
  const bytes = new Uint8Array(100_000).fill(7);
  const parts = chunkBytes(bytes);
  assert.ok(parts.every((p) => p.length <= 64 * 1024));
  assert.equal(parts.reduce((n, p) => n + p.length, 0), 100_000);
  assert.ok(chunkBytes(bytes, 1_000_000).every((p) => p.length <= 64 * 1024));
});

test("a window size is whole and inside what the server takes", () => {
  assert.deepEqual(clampSize(80.7, 24.2), { cols: 80, rows: 24 });
  assert.deepEqual(clampSize(0, 0), { cols: 2, rows: 1 });
  assert.deepEqual(clampSize(99999, 99999), { cols: 500, rows: 200 });
  assert.deepEqual(clampSize(NaN, Infinity), { cols: 2, rows: 1 });
});
