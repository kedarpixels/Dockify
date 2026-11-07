import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertPublicHost, createHttpClient, createStreamClient, getFollowing, guardedLookup, guardedPostJson, isPublicAddress, isPublicHostname, outboundUrlProblem, type Resolver,
} from "./index.ts";

/**
 * The IANA special-purpose address registries (iana-ipv4-special-registry and
 * iana-ipv6-special-registry), one entry per row, as [address block, prefix bits]. Every entry is
 * refused, including the few the registry marks "globally reachable" (AS112, AMT, PCP anycast,
 * 6to4): nothing Dockify talks to lives there, and a wrong "allow" costs more than a wrong "deny".
 */
const IANA_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["0.0.0.0", 32], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.0.0", 29], ["192.0.0.8", 32], ["192.0.0.9", 32], ["192.0.0.10", 32],
  ["192.0.0.170", 32], ["192.0.0.171", 32], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["240.0.0.0", 4], ["255.255.255.255", 32],
  // Not in the special-purpose registry but never a unicast peer: multicast.
  ["224.0.0.0", 4],
];
const IANA_V6: Array<[string, number]> = [
  ["::1", 128], ["::", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001::", 32], ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128], ["2001:2::", 48],
  ["2001:3::", 32], ["2001:4:112::", 48], ["2001:10::", 28], ["2001:20::", 28], ["2001:30::", 28],
  ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
  ["fe80::", 10],
  // Multicast, and the deprecated site-local and IPv4-compatible blocks.
  ["ff00::", 8], ["fec0::", 10], ["::", 96],
];

const v4ToInt = (ip: string): number => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const intToV4 = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
/** First, a middle and the last address of a block. */
function v4Samples(block: string, bits: number): string[] {
  const base = v4ToInt(block);
  const size = 2 ** (32 - bits);
  return [intToV4(base), intToV4(base + Math.floor(size / 2)), intToV4(base + size - 1)];
}
function v6Samples(block: string, bits: number): string[] {
  const expand = (ip: string): bigint => {
    const [head = "", tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const last = t[t.length - 1] ?? h[h.length - 1] ?? "";
    // An embedded dotted quad (::ffff:0.0.0.0) counts as two groups.
    const groups = [...h, ...new Array<string>(8 - h.length - t.length - (last.includes(".") ? 1 : 0)).fill("0"), ...t];
    let n = 0n;
    for (const g of groups) {
      if (g.includes(".")) n = (n << 32n) + BigInt(v4ToInt(g));
      else n = (n << 16n) + BigInt(parseInt(g || "0", 16));
    }
    return n;
  };
  const fmt = (n: bigint): string => {
    const parts: string[] = [];
    for (let i = 7; i >= 0; i--) parts.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
    return parts.join(":");
  };
  const base = expand(block);
  const size = 1n << BigInt(128 - bits);
  return [fmt(base), fmt(base + size / 2n), fmt(base + size - 1n)];
}

describe("isPublicAddress refuses every IANA special-purpose range", () => {
  it.each(IANA_V4)("IPv4 %s/%d", (block, bits) => {
    for (const a of v4Samples(block, bits)) expect(isPublicAddress(a), a).toBe(false);
  });
  it.each(IANA_V6)("IPv6 %s/%d", (block, bits) => {
    for (const a of v6Samples(block, bits)) expect(isPublicAddress(a), a).toBe(false);
  });
  it.each(["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "[::1]", "fe80::1%eth0", "not-an-ip", "", "2001:db8::1 "])(
    "refuses the mapped, bracketed, zoned and malformed forms: %s", (a) => expect(isPublicAddress(a)).toBe(false),
  );
  it.each(["1.1.1.1", "8.8.8.8", "140.82.112.3", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2001:4860:4860::8888"])(
    "allows global unicast %s", (a) => expect(isPublicAddress(a)).toBe(true),
  );
});

describe("isPublicHostname", () => {
  it.each(["localhost", "foo.localhost", "db", "nas.local", "svc.internal", "router.lan", "x.home.arpa", "box.localdomain", "intranet", "127.0.0.1", "10.1.2.3", "2130706433", "a.0x7f", "-bad.com", ""])(
    "refuses %s", (h) => expect(isPublicHostname(h)).toBe(false),
  );
  it.each(["api.github.com", "s3.eu-central-1.amazonaws.com", "abc.r2.cloudflarestorage.com", "8.8.8.8", "Discord.com.", "2606:4700::1111"])(
    "allows %s", (h) => expect(isPublicHostname(h)).toBe(true),
  );
});

describe("outboundUrlProblem", () => {
  it("wants https, no userinfo, a public host", () => {
    expect(outboundUrlProblem("https://hooks.example.com/x")).toBeNull();
    expect(outboundUrlProblem("http://hooks.example.com/x")).toMatch(/https/);
    expect(outboundUrlProblem("https://u:p@hooks.example.com/x")).toMatch(/credentials/);
    expect(outboundUrlProblem("https://169.254.169.254/latest")).toMatch(/public/);
    expect(outboundUrlProblem("https://[::1]/")).toMatch(/public/);
    expect(outboundUrlProblem("https://intranet/x")).toMatch(/public/);
    expect(outboundUrlProblem("nope")).toMatch(/valid/);
  });
});

describe("guardedLookup (connect time check)", () => {
  const run = (addrs: Array<{ address: string; family: number }>, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      guardedLookup((_h, cb) => cb(null, addrs))("x.example.com", { all }, (err, address) => resolve({ err, address }));
    });

  it("refuses when any resolved address is internal (rebinding)", async () => {
    const r = await run([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect(r.err?.code).toBe("EBLOCKED");
  });

  it("returns the first address, or all of them for happy eyeballs", async () => {
    expect((await run([{ address: "93.184.216.34", family: 4 }])).address).toBe("93.184.216.34");
    expect((await run([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }], true)).address).toHaveLength(2);
  });

  it("refuses an empty answer", async () => {
    expect((await run([])).err?.code).toBe("EBLOCKED");
  });
});

describe("assertPublicHost (clients without a custom lookup)", () => {
  it("refuses internal names before resolving, and any internal answer after", async () => {
    await expect(assertPublicHost("minio.internal", async () => [{ address: "8.8.8.8" }])).rejects.toThrow(/public/);
    await expect(assertPublicHost("s3.example.com", async () => [{ address: "8.8.8.8" }, { address: "172.17.0.2" }])).rejects.toThrow(/non-public/);
    await expect(assertPublicHost("s3.example.com", async () => [])).rejects.toThrow(/resolve/);
    await expect(assertPublicHost("s3.example.com", async () => [{ address: "8.8.8.8" }])).resolves.toBeUndefined();
    await expect(assertPublicHost("8.8.8.8", async () => { throw new Error("must not resolve a literal"); })).resolves.toBeUndefined();
  });
});

describe("guardedPostJson", () => {
  it("posts through the guarded client and reads Retry-After", async () => {
    const seen: unknown[] = [];
    const r = await guardedPostJson("https://discord.com/api/webhooks/1/x", { a: 1 }, 1000, async (req) => {
      seen.push(req);
      return { status: 429, headers: { "retry-after": "7" }, body: Buffer.alloc(0) };
    });
    expect(r).toEqual({ status: 429, retryAfterMs: 7000 });
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://discord.com/api/webhooks/1/x" });
  });
  it("never reaches the client for a refused URL", async () => {
    await expect(guardedPostJson("https://127.0.0.1/x", {}, 1000)).rejects.toThrow(/public/);
    await expect(guardedPostJson("http://discord.com/x", {}, 1000)).rejects.toThrow(/https/);
  });
});

describe("the http client's deadline", () => {
  /** A peer that answers headers, then drips one byte every 20 ms forever, under any idle timeout. */
  function dripping() {
    let timer: NodeJS.Timeout | undefined;
    const transport = ((_opts: unknown, onResponse: (res: EventEmitter & { statusCode: number; headers: object }) => void) => {
      const req = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
          onResponse(res);
          timer = setInterval(() => res.emit("data", Buffer.from("x")), 20);
        },
        destroy: (e?: Error) => {
          clearInterval(timer);
          if (e) req.emit("error", e);
        },
      });
      return req;
    }) as unknown as typeof httpsRequest;
    return { transport, stopped: () => clearInterval(timer) };
  }

  it("bounds the whole exchange, so a slow drip cannot hold a job", async () => {
    const peer = dripping();
    const http = createHttpClient((_h, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]), peer.transport);
    const started = Date.now();
    await expect(http({ method: "GET", url: "https://example.com/favicon.ico", timeoutMs: 150, maxBytes: 64 * 1024 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
    peer.stopped();
  });
});

describe("the streaming client", () => {
  /** A peer whose body the test writes by hand, so every chunk boundary and every timer is the test's. */
  function peer(answer = true) {
    const body = new PassThrough();
    let destroyed = false;
    let opts: Record<string, unknown> = {};
    const transport = ((o: Record<string, unknown>, onResponse: (res: unknown) => void) => {
      opts = o;
      const req = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {
          if (answer) onResponse(Object.assign(body, { statusCode: 200, headers: { "content-type": "application/stream+json" } }));
        },
        destroy: (e?: Error) => {
          destroyed = true;
          body.destroy();
          if (e) req.emit("error", e);
        },
      });
      return req;
    }) as unknown as typeof httpsRequest;
    return { body, transport, destroyed: () => destroyed, opts: () => opts };
  }
  const resolver: Resolver = (_h, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);
  const read = async (lines: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const l of lines) out.push(l);
    return out;
  };

  it("hands out whole lines across chunk boundaries, CRLF and a last line without a newline included", async () => {
    const p = peer();
    const res = await createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/v3/deployments/d/events?follow=1", headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(p.opts()).toMatchObject({ method: "GET", hostname: "api.vercel.com", path: "/v3/deployments/d/events?follow=1" });
    const got = read(res.lines());
    p.body.write('{"a":1}\n{"b"');
    p.body.write(':2}\r\n{"c":');
    p.body.end("3}");
    expect(await got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(res.ended).toBe("done");
  });

  it("cuts an over-long line once and drops its tail, then carries on with the next line", async () => {
    const p = peer();
    const res = await createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/x" });
    const got = read(res.lines(8));
    p.body.write("0123456789abcdef");
    p.body.write("ghij\nnext\n");
    p.body.end();
    expect(await got).toEqual(["01234567", "next"]);
  });

  it("stops reading at maxBytes and closes the connection", async () => {
    const p = peer();
    const res = await createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/x", maxBytes: 10 });
    const got = read(res.lines());
    p.body.write("aaaa\n");
    // Chunks count as they arrive: let the first be read before the one that crosses the cap.
    await new Promise((r) => setTimeout(r, 5));
    p.body.write("bbbbbbbbbbbb\n");
    expect(await got).toEqual(["aaaa"]);
    expect(res.ended).toBe("too_large");
    expect(p.destroyed()).toBe(true);
  });

  it("ends a body that goes quiet for idleMs, and closes the connection", async () => {
    const p = peer();
    const res = await createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/x", idleMs: 40 });
    const got = read(res.lines());
    p.body.write("one\n");
    expect(await got).toEqual(["one"]);
    expect(res.ended).toBe("idle");
    expect(p.destroyed()).toBe(true);
  });

  it("closes upstream at once when the caller's signal aborts mid-body, and when a reader stops early", async () => {
    const p = peer();
    const stop = new AbortController();
    const res = await createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/x", signal: stop.signal });
    const got = read(res.lines());
    p.body.write("one\n");
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    expect(await got).toEqual(["one"]);
    expect(res.ended).toBe("aborted");
    expect(p.destroyed()).toBe(true);

    const q = peer();
    const early = await createStreamClient(resolver, q.transport)({ url: "https://api.vercel.com/x" });
    q.body.write("a\nb\nc\n");
    for await (const l of early.lines()) if (l === "a") break;
    expect(q.destroyed()).toBe(true);
    expect(early.ended).toBe("closed");
  });

  it("bounds the wait for headers, and refuses http, private hosts and an aborted signal before connecting", async () => {
    const p = peer(false);
    await expect(createStreamClient(resolver, p.transport)({ url: "https://api.vercel.com/x", timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const never = (() => { throw new Error("must not connect"); }) as unknown as typeof httpsRequest;
    await expect(createStreamClient(resolver, never)({ url: "http://api.vercel.com/x" })).rejects.toMatchObject({ code: "URL_REFUSED" });
    await expect(createStreamClient(resolver, never)({ url: "https://169.254.169.254/latest" })).rejects.toMatchObject({ code: "URL_REFUSED" });
    await expect(createStreamClient(resolver, never)({ url: "https://api.vercel.com/x", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("checks the resolved address at connect time, like the plain client", async () => {
    const lookups: string[] = [];
    const transport = ((o: { lookup: (h: string, opts: object, cb: (e: NodeJS.ErrnoException | null) => void) => void }) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => o.lookup("api.vercel.com", {}, (e) => { lookups.push(e?.code ?? "ok"); req.emit("error", e); }),
        destroy: () => undefined,
      });
      return req;
    }) as unknown as typeof httpsRequest;
    const rebinding: Resolver = (_h, cb) => cb(null, [{ address: "10.0.0.7", family: 4 }]);
    await expect(createStreamClient(rebinding, transport)({ url: "https://api.vercel.com/x" })).rejects.toMatchObject({ code: "EBLOCKED" });
    expect(lookups).toEqual(["EBLOCKED"]);
  });
});

describe("getFollowing", () => {
  type Route = { status: number; location?: string };
  const client = (routes: Record<string, Route>) => {
    const asked: string[] = [];
    const http = async (req: { url: string }) => {
      asked.push(req.url);
      const r = routes[req.url] ?? { status: 404 };
      return { status: r.status, headers: r.location ? { location: r.location } : {}, body: Buffer.from("x") };
    };
    return { http, asked };
  };

  it("follows a few redirects, relative ones against the URL that answered", async () => {
    const { http, asked } = client({
      "https://a.example.com/logo": { status: 301, location: "https://cdn.example.com/x/logo" },
      "https://cdn.example.com/x/logo": { status: 302, location: "../y/logo.png" },
      "https://cdn.example.com/y/logo.png": { status: 200 },
    });
    expect((await getFollowing(http, "https://a.example.com/logo")).url).toBe("https://cdn.example.com/y/logo.png");
    expect(asked).toHaveLength(3);
  });

  it("refuses a redirect to http, to credentials, to a host the caller does not allow, and past the limit", async () => {
    for (const location of ["http://cdn.example.com/x", "https://u:p@cdn.example.com/x", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      const { http } = client({ "https://a.example.com/l": { status: 302, location } });
      await expect(getFollowing(http, "https://a.example.com/l"), location).rejects.toMatchObject({ code: "REDIRECT_REFUSED" });
    }
    const { http } = client({ "https://a.example.com/l": { status: 302, location: "https://evil.example/x" } });
    await expect(getFollowing(http, "https://a.example.com/l", { allow: (u) => u.hostname.endsWith(".example.com"), refused: "left the site" })).rejects.toThrow("left the site");
    const loop = client({ "https://a.example.com/l": { status: 302, location: "https://a.example.com/l" } });
    await expect(getFollowing(loop.http, "https://a.example.com/l", { maxRedirects: 2 })).rejects.toThrow("Too many redirects");
    expect(loop.asked).toHaveLength(3);
  });

  it("puts every hop through the guarded client, so a redirect to a private address is refused at connect time", async () => {
    const resolver: Resolver = (host, cb) => cb(null, [{ address: host === "internal.example.com" ? "10.0.0.9" : "93.184.216.34", family: 4 }]);
    const transport = ((o: { hostname: string; lookup: (h: string, opts: object, cb: (e: NodeJS.ErrnoException | null) => void) => void }, onRes: (r: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => o.lookup(o.hostname, {}, (e) => {
          if (e) return req.emit("error", e);
          const res = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: "https://internal.example.com/x" } });
          onRes(res);
          res.end();
        }),
        destroy: (e?: Error) => (e ? req.emit("error", e) : undefined),
        write: () => undefined,
        setTimeout: () => undefined,
      });
      return req;
    }) as unknown as typeof httpsRequest;
    await expect(getFollowing(createHttpClient(resolver, transport), "https://cdn.example.com/logo")).rejects.toMatchObject({ code: "EBLOCKED" });
  });
});
