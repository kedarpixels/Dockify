/**
 * One HTTP request over an already open connection. Never `agent: false`: that makes a new agent, which
 * ignores createConnection. A dialer's stream has no socket timeout, so the limit is a plain timer.
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
