import type { FastifyRequest } from "fastify";
import type { Actor } from "../../actor.ts";
import { GitHubClient, memoryStateStore, type StateStore } from "./github/app.ts";
import { queueDeployRequester, type DeployRequester } from "./deploy.ts";
import { createMailer, mailPolicyFromEnv, type Mailer } from "@dockify/email";
import { createHttpClient, type HttpClient } from "@dockify/net-guard";

/** Everything the handlers reach outside the database, so tests can swap each piece. */
export interface IntegrationDeps {
  http: HttpClient;
  /** The SMTP sender: the check and the test send. Everything else is queued for the worker. */
  mail: Mailer;
  github: GitHubClient;
  states: StateStore;
  deploys: DeployRequester;
  /** Send test from this process instead of through the worker: only for tests with no worker running. */
  inlineWebhookTests?: boolean;
  /** How long a Send test waits for the worker before it says the worker is busy. */
  webhookTestWait?: { waitMs: number; pollMs: number };
}

export function defaultDeps(over: Partial<IntegrationDeps> = {}): IntegrationDeps {
  const http = over.http ?? createHttpClient();
  return {
    http,
    mail: over.mail ?? createMailer(mailPolicyFromEnv()),
    github: over.github ?? new GitHubClient(http),
    states: over.states ?? memoryStateStore(),
    deploys: over.deploys ?? queueDeployRequester,
    ...(over.inlineWebhookTests ? { inlineWebhookTests: true } : {}),
    ...(over.webhookTestWait ? { webhookTestWait: over.webhookTestWait } : {}),
  };
}

export { requireActor, requireSession } from "../../actor.ts";

/** Audit fields every mutation shares. */
export const who = (actor: Actor | null, req: FastifyRequest) => ({
  actorType: actor?.kind === "token" ? ("token" as const) : ("user" as const),
  actorId: actor ? (actor.kind === "token" ? actor.tokenId : actor.userId) : null,
  actorName: actor?.name ?? null,
  ip: req.clientIp,
  userAgent: req.headers["user-agent"] ?? null,
});
