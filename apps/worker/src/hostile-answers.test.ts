/**
 * What a daemon that lies can do to the worker: every answer is read up to a ceiling, so an endless
 * body, an endless line or a false frame header ends one read and never the process.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAll } from "./data/context.ts";
import { Demuxer, DockerError } from "@dockify/engine";
import { createDockerReader, MAX_ANSWER_BYTES } from "./observe/docker.ts";
import { LineSplitter, MAX_LINE } from "./observe/logparse.ts";

describe("observe's Docker reads are capped", () => {
  let server: Server;
  let sent = 0;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.includes("/stats")) {
        res.end(JSON.stringify({ pids_stats: { current: 3 } }));
        return;
      }
      // Well past the cap, one megabyte at a time, stopping when the client hangs up.
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      const pump = () => {
        while (sent < MAX_ANSWER_BYTES * 4 && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("an answer past the cap fails that read", async () => {
    const reader = createDockerReader({ host: "127.0.0.1", port });
    await expect(reader.listManaged()).rejects.toMatchObject({ name: "DockerError", status: 502 });
    expect(sent).toBeLessThan(MAX_ANSWER_BYTES * 4);
  });

  it("a small answer still reads", async () => {
    const reader = createDockerReader({ host: "127.0.0.1", port });
    await expect(reader.stats("a".repeat(64))).resolves.toEqual({ pids_stats: { current: 3 } });
  });
});

describe("line and frame caps", () => {
  it("a line with no newline stays bounded across frames", () => {
    const s = new LineSplitter();
    for (let i = 0; i < 50; i++) s.push({ stream: "stdout", payload: Buffer.alloc(1024 * 1024, 0x61) });
    const [line] = s.push({ stream: "stdout", payload: Buffer.from("\n") });
    expect(line!.raw.length).toBeLessThanOrEqual(MAX_LINE * 2);
  });

  it("one enormous line inside a single frame is bounded too", () => {
    const s = new LineSplitter();
    const lines = s.push({ stream: "stderr", payload: Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 0x62), Buffer.from("\nnext\n")]) });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.raw.length).toBeLessThanOrEqual(MAX_LINE * 2);
    expect(lines[1]!.raw).toBe("next");
  });

  it("a false frame header is refused, not buffered", () => {
    const header = Buffer.from([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    expect(() => new Demuxer().push(header, () => {})).toThrow(DockerError);
  });

  it("an ordinary frame still passes", () => {
    const body = Buffer.from("hello");
    const header = Buffer.from([2, 0, 0, 0, 0, 0, 0, body.length]);
    const got: Array<[string, string]> = [];
    new Demuxer().push(Buffer.concat([header, body]), (k, d) => got.push([k, d.toString()]));
    expect(got).toEqual([["stderr", "hello"]]);
  });

  it("a helper's chatter is capped", async () => {
    async function* many() {
      for (let i = 0; i < 100; i++) yield Buffer.alloc(64 * 1024, 0x63);
    }
    const text = await readAll(many() as unknown as NodeJS.ReadableStream);
    expect(text.length).toBe(64 * 1024);
  });
});
