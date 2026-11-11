import type { FastifyInstance } from "fastify";
import { endpoints, type EndpointDef, type EndpointId } from "@dockify/contracts";
import type { Ctx, Handler } from "./app.ts";
import { notImplemented } from "./errors.ts";
import { POLICIES } from "./policy.ts";

/** An endpoint with no handler answers 501. */
export function mountEndpoint(app: FastifyInstance, ctx: Ctx, id: EndpointId, handler: Handler<EndpointId> | undefined): void {
  const def = endpoints[id] as EndpointDef;
  app.route({
    method: def.method,
    url: def.path,
    schema: {
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { querystring: def.query } : {}),
      ...(def.body ? { body: def.body } : {}),
    },
    config: { policy: POLICIES[id], endpoint: id },
    handler: async (req, reply) => {
      if (!handler) throw notImplemented();
      const out = await handler({
        body: req.body as never,
        query: req.query as never,
        params: req.params as never,
        actor: req.actor,
        req,
        reply,
        ctx,
      });
      if (reply.sent) return reply;
      // A handler may pick another success status (a long restore answers 202, for example).
      const chosen = reply.statusCode !== 200 ? reply.statusCode : undefined;
      if ((def.kind ?? "json") === "none") return reply.code(chosen ?? def.status ?? 204).send();
      return reply.code(chosen ?? def.status ?? 200).send(out ?? {});
    },
  });
}
