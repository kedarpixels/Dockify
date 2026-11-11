import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerClient } from "@dockify/engine";
import { EngineDataPort, wireDemux } from "./engine-port.ts";

/** One frame of Docker's multiplexed stream: stream id, three zero bytes, the length, the bytes. */
const frame = (kind: number, body: Buffer): Buffer => {
  const h = Buffer.alloc(8);
  h[0] = kind;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
};
const tick = () => new Promise((r) => setImmediate(r));

describe("the exec stream's backpressure", () => {
  it("pauses the source while nobody reads stdout, and passes everything on once somebody does", async () => {
    const src = new PassThrough();
    const io = wireDemux(src, null);
    const chunk = Buffer.alloc(64 * 1024, 7);
    for (let i = 0; i < 4; i++) src.write(frame(1, chunk));
    await tick();
    // Held at the source, not copied into this process.
    expect(src.isPaused()).toBe(true);
    expect(io.stdout.readableLength).toBeLessThanOrEqual(chunk.length);

    let got = 0;
    io.stdout.on("data", (c: Buffer) => (got += c.length));
    src.end(frame(2, Buffer.from("warn")));
    await io.ended;
    await tick();
    expect(got).toBe(4 * chunk.length);
    expect(io.stderr.text()).toBe("warn");
  });

  it("a reader that went away does not leave the source paused", async () => {
    const src = new PassThrough();
    const io = wireDemux(src, null);
    src.write(frame(1, Buffer.alloc(64 * 1024)));
    await tick();
    expect(src.isPaused()).toBe(true);
    io.stdout.destroy();
    src.end(frame(1, Buffer.alloc(64 * 1024)));
    await io.ended;
  });
});

describe("a killed exec", () => {
  let server: Server | null = null;
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("is not waited for when its process never exits", async () => {
    server = createServer();
    // The hijack: the daemon answers 101 and the process says nothing, like a dump waiting on a lock.
    server.on("upgrade", (_req, socket) => {
      sockets.push(socket as Socket);
      socket.on("error", () => {});
      socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const client = {
      target: { host: "127.0.0.1", port: (server.address() as AddressInfo).port },
      call: async (_method: string, path: string) => (path.endsWith("/exec") ? { Id: "e1" } : { Running: true, ExitCode: null }),
    } as unknown as DockerClient;
    const h = await new EngineDataPort(client).exec("dk-a", { cmd: ["pg_dump"] });
    h.stdout.resume();
    await h.kill();
    expect(await h.done).toEqual({ exitCode: 137, stderr: "" });
  });
});
