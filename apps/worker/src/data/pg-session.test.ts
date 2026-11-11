import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectPg } from "./pg-session.ts";

/** Just enough of Postgres' wire protocol: trust auth, then whatever `onMessage` answers. */
const message = (type: string, body: Buffer = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const READY = message("Z", Buffer.from("I"));
/** One row of one text column. */
const row = (value: string) => {
  const name = Buffer.concat([Buffer.from("n\0"), Buffer.alloc(18)]);
  name.writeUInt32BE(25, 8);
  name.writeInt16BE(-1, 12);
  name.writeInt32BE(-1, 14);
  const head = Buffer.alloc(6);
  head.writeInt16BE(1, 0);
  head.writeInt32BE(value.length, 2);
  return Buffer.concat([message("T", Buffer.concat([Buffer.from([0, 1]), name])), message("D", Buffer.concat([head, Buffer.from(value)])), message("C", Buffer.from("SELECT 1\0")), READY]);
};

let server: Server | null = null;
const open: Socket[] = [];
afterEach(async () => {
  for (const s of open) s.destroy();
  open.length = 0;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A session against a fake server. `onMessage` sees each client message's type letter after the startup. */
async function session(onMessage: (type: string, s: Socket, data: Buffer) => void, wireMax?: number) {
  const backends: Socket[] = [];
  server = createServer((s) => {
    backends.push(s);
    open.push(s);
    s.on("error", () => {});
    let started = false;
    s.on("data", (d: Buffer) => {
      if (!started) {
        started = true;
        return void s.write(Buffer.concat([message("R", Buffer.alloc(4)), READY]));
      }
      onMessage(String.fromCharCode(d[0]!), s, d);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const stream = connect((server.address() as AddressInfo).port, "127.0.0.1");
  open.push(stream);
  await new Promise<void>((r) => stream.once("connect", () => r()));
  const pg = await connectPg(stream, { user: "u", password: "p", database: "d" }, wireMax);
  return { pg, backend: backends[0]!, stream };
}

describe("the data browser's Postgres session", () => {
  it("survives being terminated while idle: the next query fails, the process does not", async () => {
    // The tenant's pg_terminate_backend, between two queries. Unheard, the client's error event is
    // an uncaught exception, which this run would report as a failure.
    const s = await session((type, sock) => {
      if (type === "Q") sock.write(row("hi"));
    });
    expect((await s.pg.query("SELECT 'hi'")).rows).toEqual([["hi"]]);
    s.backend.write(message("E", Buffer.from("SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0")));
    s.backend.destroy();
    await new Promise<void>((r) => s.stream.once("close", () => r()));
    await expect(s.pg.query("SELECT 1")).rejects.toThrow();
    await s.pg.close();
  });

  it("sends a query with a value list, even an empty one, as one prepared statement", async () => {
    const seen: string[] = [];
    const s = await session((type, sock, d) => {
      if (type === "X") return;
      // Parse, Bind, Describe, Execute and Sync arrive together: the text is in the Parse message.
      seen.push(type === "P" ? `P ${d.subarray(6, d.indexOf(0, 6)).toString()}` : type);
      if (type === "Q") return void sock.write(row("x"));
      sock.write(Buffer.concat([message("E", Buffer.from("SERROR\0VERROR\0C42601\0Mcannot insert multiple commands into a prepared statement\0\0")), READY]));
    });
    await s.pg.query("SELECT 'x'");
    await expect(s.pg.query("select 1; commit", [])).rejects.toThrow(/multiple commands/);
    expect(seen).toEqual(["Q", "P select 1; commit"]);
    await s.pg.close();
  });

  it("drops the connection when one answer passes the wire budget, and says why", async () => {
    const s = await session((type, sock) => {
      if (type === "Q") sock.write(row("x".repeat(64 * 1024)));
    }, 4096);
    await expect(s.pg.query("SELECT big FROM t")).rejects.toMatchObject({ code: "RESULT_TOO_LARGE", status: 413 });
    expect(s.stream.destroyed).toBe(true);
    await s.pg.close();
  });

  it("counts each query's answer on its own", async () => {
    const s = await session((type, sock) => {
      if (type === "Q") sock.write(row("x".repeat(3000)));
    }, 4096);
    for (let i = 0; i < 3; i++) expect((await s.pg.query("SELECT 1")).rows[0]![0]).toHaveLength(3000);
    await s.pg.close();
  });
});
