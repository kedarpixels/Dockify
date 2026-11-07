/**
 * The worker's side of the link to this install's servers, with one server: the listener its agent
 * dials, the one-time token that server joins with, and the facts its agent reports. While the link
 * is down the server's claim loops wait; the Server page says so once it has lasted.
 */
import { readFile } from "node:fs/promises";
import type { Db } from "@dockify/db";
import type { WorkerHealth } from "../health.ts";
import { enroll, offerPrimaryToken, serverByPin } from "./enroll.ts";
import { createLinkListener, type LinkListener } from "./listener.ts";
import { readAgentInfo } from "./remote.ts";
import { ServerLink, type LinkSession } from "./session.ts";

export const LINK_ISSUE = "server_link";
const LINK_SUMMARY = "cannot reach this server's agent; deploys and backups wait";
/** A restart of either side is a few seconds and says nothing. */
const LINK_ISSUE_AFTER_MS = 45_000;

export interface PrimaryLink {
  link: ServerLink;
  listener: LinkListener;
  stop(): Promise<void>;
}

export interface PrimaryLinkOptions {
  db: Db;
  serverId: string;
  env: NodeJS.ProcessEnv;
  health: WorkerHealth;
  log: (msg: string, extra?: object) => void;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** What the agent says about itself, on the servers row. Lies only ever concern that one server. */
export async function recordAgentFacts(db: Db, session: LinkSession, link: ServerLink): Promise<void> {
  const info = await readAgentInfo(link);
  await db.server.update({
    where: { id: session.serverId },
    data: {
      hostname: info.hostname || null,
      publicIpv4: info.publicIpv4,
      publicIpv6: info.publicIpv6,
      os: info.os,
      kernel: info.kernel,
      dockerVersion: info.dockerVersion,
      agentVersion: info.version,
      agentProto: info.proto,
      cpuCores: info.cores,
      memoryBytes: BigInt(info.memoryBytes),
      clockSkewMs: Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(info.clock - Date.now()))),
      lastSeenAt: new Date(),
    },
  });
}

export async function startPrimaryLink(o: PrimaryLinkOptions): Promise<PrimaryLink> {
  const { db, env, log } = o;
  const [key, cert] = await Promise.all([readFile(required(env, "DOCKIFY_LINK_KEY_FILE")), readFile(required(env, "DOCKIFY_LINK_CERT_FILE"))]);
  const tokenFile = env.DOCKIFY_JOIN_TOKEN_FILE?.trim();
  if (tokenFile) await offerPrimaryToken(db, tokenFile);
  const link = new ServerLink(o.serverId);
  const listener = createLinkListener({
    key,
    cert,
    serverByPin: (pin) => serverByPin(db, pin),
    enroll: (token, pin, ip) => enroll(db, token, pin, ip),
    existing: (serverId) => (serverId === o.serverId ? link.peek() : null),
    onSession: (session) => {
      // One server for now: the listener's other answers wait for a registry that can hold them.
      if (session.serverId !== o.serverId) return session.destroy();
      link.attach(session);
      void session.wait().then(() => link.detach(session));
      void recordAgentFacts(db, session, link).catch((e: unknown) => log("could not record what the agent reports", { error: e instanceof Error ? e.message : String(e) }));
    },
    log,
  });
  await listener.listen(Number(env.DOCKIFY_LINK_PORT ?? 3003), required(env, "DOCKIFY_LINK_BIND"));

  let downSince = Date.now();
  const watch = setInterval(() => {
    if (link.up) {
      downSince = Date.now();
      if (o.health.clear(LINK_ISSUE)) log("the link to this server's agent is back");
    } else if (Date.now() - downSince >= LINK_ISSUE_AFTER_MS) {
      const message = "The worker has no link to this server's agent, so nothing can reach Docker. Sites keep serving. See `dockify logs agent` on the server.";
      if (o.health.set(LINK_ISSUE, LINK_SUMMARY, message)) log(message);
    }
  }, 5_000);
  watch.unref();

  return {
    link,
    listener,
    async stop() {
      clearInterval(watch);
      link.peek()?.destroy();
      await listener.close();
    },
  };
}
