/**
 * One HTTP request over a connection that is already open, whatever carries it. Never through an
 * agent: `agent: false` would make a new agent, which ignores createConnection. The connection closes
 * with the request. A stream from a dialer need not be a socket, and so has no socket timeout for
 * node:http to set, so the time limit here is a plain timer over the whole request.
 */
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import type { Duplex } from "node:stream";

export type OverOptions = Omit<RequestOptions, "createConnection" | "agent" | "timeout"> & { timeoutMs: number };

export function requestOver(connection: Duplex, options: OverOptions, onResponse: (res: IncomingMessage) => void): ClientRequest {
  const { timeoutMs, ...rest } = options;
  const req = request({ ...rest, createConnection: () => connection }, onResponse);
  const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
  req.once("close", () => {
    clearTimeout(timer);
    connection.destroy();
  });
  return req;
}
