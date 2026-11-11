import type { Duplex } from "node:stream";
import { hijackDocker } from "../data/engine-port.ts";
import { DockerError, isNotFound, type ContainerInfo, type DockerClient } from "@dockify/engine";
import type { ExecBody, ExecInfo, TerminalDocker } from "./session.ts";

export class EngineTerminalPort implements TerminalDocker {
  private readonly client: DockerClient;
  constructor(client: DockerClient) {
    this.client = client;
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    try {
      return await this.client.inspectContainer(name);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async createExec(name: string, body: ExecBody): Promise<string> {
    return (await this.client.call<{ Id: string }>("POST", `/containers/${encodeURIComponent(name)}/exec`, body)).Id;
  }
  inspectExec(id: string) {
    return this.client.call<ExecInfo>("GET", `/exec/${encodeURIComponent(id)}/json`);
  }
  async attachExec(id: string): Promise<{ stream: Duplex; head: Buffer }> {
    const h = await hijackDocker(this.client.target, `/exec/${encodeURIComponent(id)}/start`, { Detach: false, Tty: true });
    // An engine that answers without upgrading gives a one-way stream, which cannot carry a keystroke.
    if (!h.writable) {
      h.socket.destroy();
      throw new DockerError(502, "the daemon did not upgrade the exec stream");
    }
    return { stream: h.socket as Duplex, head: h.head ?? Buffer.alloc(0) };
  }
  async startDetached(id: string): Promise<void> {
    await this.client.call("POST", `/exec/${encodeURIComponent(id)}/start`, { Detach: true, Tty: false }, true);
  }
  /** The socket proxy allows exactly this query, in this order, on a full exec id. */
  async resizeExec(id: string, cols: number, rows: number): Promise<void> {
    await this.client.call("POST", `/exec/${encodeURIComponent(id)}/resize?h=${rows}&w=${cols}`, undefined, true);
  }
}
