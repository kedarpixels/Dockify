/** Found on the box: an agent whose session ran out of memory refuses every stream and still answers pings. */
import { connect, constants as h2c, createServer, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LinkSession } from "./session.ts";

let server: Http2Server | undefined;
afterEach(() => server?.close());

async function session(code: number): Promise<LinkSession> {
  server = createServer();
  server.on("stream", (st) => { st.on("error", () => {}); st.close(code); });
  server.on("session", (s) => s.on("error", () => {}));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const h2 = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await new Promise((r) => h2.once("connect", r));
  return new LinkSession(h2, { serverId: "s", infoOnly: false, pingEveryMs: 60_000 });
}
const closed = (st: NodeJS.EventEmitter) => new Promise<void>((r) => { st.on("error", () => {}); st.once("close", () => r()); });

describe("LinkSession", () => {
  it("ends itself when the far end says it is out of memory, so the agent redials", async () => {
    const s = await session(h2c.NGHTTP2_ENHANCE_YOUR_CALM);
    const st = s.stream("/v1/docker"); const done = closed(st); st.end(); await done;
    await s.wait();
    expect(s.alive).toBe(false);
  });

  it("is not ended by any other refused stream", async () => {
    const s = await session(h2c.NGHTTP2_INTERNAL_ERROR);
    const st = s.stream("/v1/docker"); const done = closed(st); st.end(); await done;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.alive).toBe(true);
    s.destroy();
  });
});
