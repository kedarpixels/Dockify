/**
 * What moved onto a dialled connection, over real sockets on loopback: the readiness probes, the
 * status page's probe with and without TLS, the proxy's ping and counters, the certificate check, the
 * Docker client and reader, Postgres and Redis. Each keeps the headers, caps and time limits it had.
 */
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingHttpHeaders, type RequestListener, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPg, connectedStream } from "../data/pg-session.ts";
import { hijackDocker } from "../data/engine-port.ts";
import { connectRedis, RespError } from "../data/resp.ts";
import { DockerClient } from "@dockify/engine";
import { dialProbes } from "../deploy/readiness.ts";
import { proxyCertificateReady } from "../edge/tls.ts";
import { traefikCounters } from "../integrations/previews.ts";
import { proxyPing } from "../observe/alert-runner.ts";
import { createDockerReader } from "../observe/docker.ts";
import { proxyProbe } from "../observe/reach.ts";
import type { Dialer } from "./runtime.ts";

const open: Array<{ close(): unknown; closeAllConnections?: () => void }> = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function listen<T extends Server | HttpServer>(s: T): Promise<number> {
  open.push(s as never);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return (s.address() as AddressInfo).port;
}
const http = (fn: RequestListener) => listen(createHttpServer(fn));
const dialTo = (port: number): Dialer => () => new Promise((resolve, reject) => {
  const s = connect({ host: "127.0.0.1", port });
  s.once("connect", () => resolve(s));
  s.once("error", reject);
});
const refused: Dialer = async () => {
  throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
};
const never = new AbortController().signal;

describe("the readiness probes", () => {
  const probes = (dial: Dialer) => dialProbes(dial, "c1", "dockify-env-e1", never);

  it("asks the dialer for the container on its network, by name, not for the address it was handed", async () => {
    const asked: unknown[] = [];
    const port = await http((_q, a) => a.end());
    const dial: Dialer = (t, o) => {
      asked.push({ t, timeoutMs: o?.timeoutMs });
      return dialTo(port)(t, o);
    };
    expect(await probes(dial).tcp("10.9.9.9", 3000, 1_000)).toBe(true);
    expect(asked).toEqual([{ t: { container: "c1", network: "dockify-env-e1", port: 3000 }, timeoutMs: 1_000 }]);
  });

  it("reads a refused connection as not listening and no status", async () => {
    expect(await probes(refused).tcp("10.9.9.9", 3000, 1_000)).toBe(false);
    expect(await probes(refused).http("10.9.9.9", 3000, "/h", 1_000, null)).toBeNull();
  });

  it("sends the domain as Host when there is one, and the address when there is not, as it always did", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const paths: Array<string | undefined> = [];
    const port = await http((q, a) => {
      seen.push(q.headers);
      paths.push(q.url);
      a.statusCode = 204;
      a.end();
    });
    const { http: get } = probes(dialTo(port));
    expect(await get("10.9.9.9", 3000, "/health", 1_000, "shop.example.com")).toBe(204);
    expect(await get("10.9.9.9", 3000, "/health", 1_000, null)).toBe(204);
    expect(paths).toEqual(["/health", "/health"]);
    expect(seen[0]!.host).toBe("shop.example.com");
    expect(seen[0]!["user-agent"]).toBe("Dockify-Readiness");
    expect(seen[1]!.host).toBe("10.9.9.9:3000");
  });

  it("gives up at its time limit on a server that takes the request and never answers", async () => {
    const port = await http(() => {});
    const started = Date.now();
    expect(await probes(dialTo(port)).http("10.9.9.9", 3000, "/h", 60, null)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("lets go of the connection once it has the status, whatever the body does", async () => {
    let peerClosed!: () => void;
    const gone = new Promise<void>((r) => (peerClosed = r));
    const port = await http((q, a) => {
      q.socket.once("close", peerClosed);
      a.write("an endless body");
    });
    expect(await probes(dialTo(port)).http("10.9.9.9", 3000, "/h", 5_000, null)).toBe(200);
    await gone;
  });
});

describe("the status page's probe", () => {
  it("over plain http: the hostname as Host, the app's path, and Traefik's no-route 404 reads as unreachable", async () => {
    const seen: Array<{ host?: string; url?: string }> = [];
    const port = await http((q, a) => {
      seen.push({ host: q.headers.host, url: q.url });
      if (q.url === "/none") {
        a.statusCode = 404;
        a.end("404 page not found\n");
      } else if (q.url === "/bad") {
        a.statusCode = 502;
        a.end();
      } else {
        a.end("ok");
      }
    });
    const asked: unknown[] = [];
    const dial: Dialer = (t, o) => {
      asked.push(t);
      return dialTo(port)(t, o);
    };
    const probe = proxyProbe({ dial, tls: false, timeoutMs: 2_000 });
    expect(await probe({ appId: "a", hostname: "x.example.com", path: "/ok" })).toBe(true);
    expect(await probe({ appId: "a", hostname: "x.example.com", path: "/none" })).toBe(false);
    expect(await probe({ appId: "a", hostname: "x.example.com", path: "/bad" })).toBe(false);
    expect(seen[0]).toEqual({ host: "x.example.com", url: "/ok" });
    expect(asked[0]).toEqual({ proxy: 80 });
  });

  it("reads a dial that fails, and a proxy that never answers, as unreachable", async () => {
    expect(await proxyProbe({ dial: refused, tls: false })({ appId: "a", hostname: "x.example.com", path: "/" })).toBe(false);
    const port = await http(() => {});
    expect(await proxyProbe({ dial: dialTo(port), tls: false, timeoutMs: 50 })({ appId: "a", hostname: "x.example.com", path: "/" })).toBe(false);
  });

  it("over TLS: port 443, the hostname as SNI, and a certificate it does not judge", async () => {
    const sni: unknown[] = [];
    const hosts: Array<string | undefined> = [];
    const inner = createHttpServer((q, a) => {
      hosts.push(q.headers.host);
      a.end("ok");
    });
    const tls = createTlsServer({ key: TEST_KEY, cert: TEST_CERT, ALPNProtocols: ["http/1.1"] }, (s) => {
      sni.push(s.servername);
      inner.emit("connection", s);
    });
    const port = await listen(tls);
    open.push(inner);
    const asked: unknown[] = [];
    const dial: Dialer = (t, o) => {
      asked.push(t);
      return dialTo(port)(t, o);
    };
    expect(await proxyProbe({ dial, tls: true, timeoutMs: 3_000 })({ appId: "a", hostname: "test.example.com", path: "/" })).toBe(true);
    expect(asked).toEqual([{ proxy: 443 }]);
    expect(sni).toEqual(["test.example.com"]);
    expect(hosts).toEqual(["test.example.com"]);
  });
});

describe("the certificate check", () => {
  it("handshakes over the dialled connection, and an untrusted certificate is not ready", async () => {
    const sni: unknown[] = [];
    const tls = createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => {
      sni.push(s.servername);
      s.on("error", () => {});
    });
    const port = await listen(tls);
    const asked: unknown[] = [];
    const dial: Dialer = (t, o) => {
      asked.push(t);
      return dialTo(port)(t, o);
    };
    expect(await proxyCertificateReady(dial)("test.example.com")).toBe(false);
    expect(asked).toEqual([{ proxy: 443 }]);
    await vi.waitFor(() => expect(sni).toEqual(["test.example.com"]));
  });

  it("rejects when the proxy cannot be dialled, which the wait reads as not ready", async () => {
    await expect(proxyCertificateReady(refused)("test.example.com")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("the proxy's ping and counters", () => {
  it("ping: /ping on 8080, up under 500, down otherwise", async () => {
    const urls: Array<string | undefined> = [];
    let status = 200;
    const port = await http((q, a) => {
      urls.push(q.url);
      a.statusCode = status;
      a.end();
    });
    const asked: unknown[] = [];
    const dial: Dialer = (t, o) => {
      asked.push(t);
      return dialTo(port)(t, o);
    };
    expect(await proxyPing(dial)()).toBe(true);
    status = 503;
    expect(await proxyPing(dial)()).toBe(false);
    expect(await proxyPing(refused)()).toBe(false);
    expect(urls).toEqual(["/ping", "/ping"]);
    expect(asked[0]).toEqual({ proxy: 8080 });
  });

  it("counters: /metrics on 8082, parsed; null when not 200 or not there", async () => {
    let status = 200;
    const id = "0f0e0d0c-0000-4000-8000-0000000000aa";
    const port = await http((q, a) => {
      a.statusCode = status;
      a.end(q.url === "/metrics" ? `traefik_service_requests_total{code="200",method="GET",protocol="http",service="pv-${id}@file"} 7\n` : "");
    });
    expect(await traefikCounters(dialTo(port))()).toEqual(new Map([[`pv-${id}`, 7]]));
    status = 500;
    expect(await traefikCounters(dialTo(port))()).toBeNull();
    expect(await traefikCounters(refused)()).toBeNull();
  });

  it("counters: stops reading past the cap and reads as null", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const port = await http((_q, a) => {
      const pump = () => {
        while (sent < 32 * chunk.length && !a.destroyed) {
          sent += chunk.length;
          if (!a.write(chunk)) return void a.once("drain", pump);
        }
        a.end();
      };
      pump();
    });
    expect(await traefikCounters(dialTo(port))()).toBeNull();
    expect(sent).toBeLessThan(32 * chunk.length);
  });
});

describe("the Docker client and reader over createConnection", () => {
  /** A stream the endpoint makes itself: no host, no port, no socket path anywhere. */
  const endpointTo = (port: number, made: { n: number }) => ({
    createConnection: (): Duplex => {
      made.n += 1;
      return connect({ host: "127.0.0.1", port });
    },
  });

  it("carries every request over the stream it makes", async () => {
    const made = { n: 0 };
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const port = await http((q, a) => {
      let body = "";
      q.on("data", (c: Buffer) => (body += c.toString()));
      q.on("end", () => {
        seen.push({ method: q.method, url: q.url, body });
        a.setHeader("Content-Type", "application/json");
        a.end(q.url?.includes("/json") ? JSON.stringify({ Id: "c1" }) : JSON.stringify({ Id: "new" }));
      });
    });
    const docker = new DockerClient(endpointTo(port, made), { cpuCores: 4 });
    expect(await docker.call("GET", "/containers/c1/json")).toEqual({ Id: "c1" });
    expect(await docker.createContainer("dk-a", { name: "dk-a", image: "alpine:3", network: "dockify-env-a" })).toBe("new");
    expect(made.n).toBe(2);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1.43/containers/c1/json" });
    expect(JSON.parse(seen[1]!.body).HostConfig.NanoCpus).toBe(3e9);
  });

  it("refuses a create with no limit of its own and no known count, and allows one with its own", async () => {
    const port = await http((_q, a) => a.end(JSON.stringify({ Id: "new" })));
    const docker = new DockerClient({ host: "127.0.0.1", port }, { cpuCores: null });
    const input = { name: "dk-a", image: "alpine:3", network: "dockify-env-a" };
    await expect(docker.createContainer("dk-a", input)).rejects.toThrow(/core count is not known/);
    expect(await docker.createContainer("dk-a", { ...input, cpuCores: 0.5 })).toBe("new");
  });

  it("the reader takes the same endpoint", async () => {
    const made = { n: 0 };
    const port = await http((q, a) => a.end(JSON.stringify(q.url?.includes("/stats") ? { pids_stats: { current: 3 } } : [])));
    const reader = createDockerReader(endpointTo(port, made));
    expect(await reader.stats("a".repeat(64))).toEqual({ pids_stats: { current: 3 } });
    expect(await reader.listManaged()).toEqual([]);
    expect(made.n).toBe(2);
  });

  it("a hijacked exec spreads it too", async () => {
    const made = { n: 0 };
    const server = createHttpServer();
    server.on("upgrade", (_q, socket) => {
      socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      socket.on("data", (d) => socket.write(d));
    });
    const port = await listen(server);
    const h = await hijackDocker(endpointTo(port, made), "/exec/x/start", {});
    expect(h.writable).toBe(true);
    const duplex = h.socket as Socket;
    duplex.write("ping");
    const [echo] = await once(duplex, "data");
    expect(echo.toString()).toBe("ping");
    duplex.destroy();
    expect(made.n).toBe(1);
  });
});

/** Just enough of Postgres' wire protocol: trust auth, ready, one row of one text column per query. */
const pgMessage = (type: string, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
function fakePostgres(): { server: Server; startups: string[]; queries: string[]; closed: Promise<void> } {
  const startups: string[] = [];
  const queries: string[] = [];
  let markClosed = () => {};
  const closed = new Promise<void>((r) => (markClosed = r));
  const server = createServer((s) => {
    s.on("error", () => {});
    s.on("close", markClosed);
    let started = false;
    s.on("data", (d: Buffer) => {
      if (!started) {
        started = true;
        startups.push(d.toString("latin1"));
        const auth = Buffer.alloc(4);
        s.write(Buffer.concat([pgMessage("R", auth), pgMessage("Z", Buffer.from("I"))]));
        return;
      }
      if (d[0] === 0x58) return void s.end();
      if (d[0] !== 0x51) return;
      queries.push(d.subarray(5, d.length - 1).toString());
      const name = Buffer.concat([Buffer.from("n\0"), Buffer.alloc(18)]);
      name.writeUInt32BE(25, 8);
      name.writeInt16BE(-1, 12);
      name.writeInt32BE(-1, 14);
      const fields = Buffer.concat([Buffer.from([0, 1]), name]);
      const rowHead = Buffer.alloc(6);
      rowHead.writeInt16BE(1, 0);
      rowHead.writeInt32BE(2, 2);
      s.write(Buffer.concat([
        pgMessage("T", fields),
        pgMessage("D", Buffer.concat([rowHead, Buffer.from("hi")])),
        pgMessage("C", Buffer.from("SELECT 1\0")),
        pgMessage("Z", Buffer.from("I")),
      ]));
    });
  });
  return { server, startups, queries, closed };
}

describe("Postgres over a connection that is already open", () => {
  it("runs a session on it, with the same user, database and name, and closes it at the end", async () => {
    const pg = fakePostgres();
    const port = await listen(pg.server);
    const stream = await dialTo(port)({ proxy: 80 });
    const session = await connectPg(stream, { user: "dockify", password: "pw", database: "app" });
    expect(await session.query("SELECT 'hi'")).toEqual({ fields: [{ name: "n", dataTypeID: 25 }], rows: [["hi"]] });
    expect(pg.queries).toEqual(["SELECT 'hi'"]);
    expect(pg.startups[0]).toContain("user\0dockify");
    expect(pg.startups[0]).toContain("database\0app");
    expect(pg.startups[0]).toContain("application_name\0dockify-data-browser");
    await session.close();
    await pg.closed;
    expect(stream.destroyed).toBe(true);
  });

  it("closes the connection when the session cannot be made", async () => {
    const server = createServer((s) => {
      s.on("error", () => {});
      s.on("data", () => s.write(pgMessage("E", Buffer.from("SFATAL\0C28000\0Mno\0\0"))));
    });
    const stream = await dialTo(await listen(server))({ proxy: 80 });
    await expect(connectPg(stream, { user: "u", password: "p", database: "d" })).rejects.toThrow(/no/);
    expect(stream.destroyed).toBe(true);
  });

  it("answers node-postgres' connect calls itself and passes everything else to the stream", async () => {
    const port = await listen(createServer((s) => void s.on("error", () => {})));
    const stream = await dialTo(port)({ proxy: 80 });
    const adapted = connectedStream(stream) as Duplex & { connect(): unknown; setNoDelay(): unknown };
    expect(adapted.connect()).toBe(adapted);
    expect(adapted.setNoDelay()).toBe(adapted);
    const connected = new Promise<void>((r) => void adapted.once("connect", () => r()));
    await connected;
    expect(adapted.writable).toBe(true);
    adapted.destroy();
    expect(stream.destroyed).toBe(true);
  });
});

describe("Redis over a connection it is handed", () => {
  it("authenticates and runs a command", async () => {
    const seen: string[] = [];
    const server = createServer((s) => {
      s.on("error", () => {});
      s.on("data", (d) => {
        seen.push(d.toString());
        s.write("+OK\r\n");
      });
    });
    const port = await listen(server);
    const conn = await connectRedis({ connect: (timeoutMs) => dialTo(port)({ proxy: 80 }, { timeoutMs }), password: "pw" });
    expect(await conn.command(["PING"])).toBe("OK");
    conn.close();
    expect(seen[0]).toContain("AUTH");
  });

  it("gives its own message when the dial times out, and passes on any other failure", async () => {
    const late = Object.assign(new Error("did not answer"), { code: "ETIMEDOUT" });
    await expect(connectRedis({ connect: async () => { throw late; }, password: "p" })).rejects.toThrow(RespError);
    await expect(connectRedis({ connect: async () => { throw late; }, password: "p" })).rejects.toThrow(/could not connect to Redis in time/);
    await expect(connectRedis({ connect: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }, password: "p" })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQbEJZkjIBa8K+rAW
2/PhPhxJRxeJGRbesNkXtS/DbcuhRANCAASkdwQBer/NBO+ynboXlbOwU4cYuyIr
AF6t4f1FQNzHSaduT/uaPDLrIOpvu52mbhtvsQAX+Wfw8NjcaiSNTRCW
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBqjCCAVCgAwIBAgIUMSASriPqX9UFRaDPPLc71x5mSWUwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTAgFw0yNjExMDYxODM2MTlaGA8y
MTI2MTAxMzE4MzYxOVowGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABKR3BAF6v80E77KduheVs7BThxi7IisAXq3h
/UVA3MdJp25P+5o8Musg6m+7naZuG2+xABf5Z/Dw2NxqJI1NEJajcDBuMB0GA1Ud
DgQWBBQBvc2yOX6H4zxzJ6SgHEpO76pAFzAfBgNVHSMEGDAWgBQBvc2yOX6H4zxz
J6SgHEpO76pAFzAPBgNVHRMBAf8EBTADAQH/MBsGA1UdEQQUMBKCEHRlc3QuZXhh
bXBsZS5jb20wCgYIKoZIzj0EAwIDSAAwRQIhAL6i44nGTbgDkgmYodKf9ioCoXi3
7ruyWHjQFosMjYKgAiBuOKaUvAdsKAvC6PLKjdgwu/N+wyNy7Gfsx57eel9X0Q==
-----END CERTIFICATE-----
`;
