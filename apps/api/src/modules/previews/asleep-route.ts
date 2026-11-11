// Static on purpose: this answers anyone who has the link, crawlers included, so it names no
// project, pull request or person, and a visit does not wake anything.
import type { FastifyInstance } from "fastify";
import { PREVIEW_ASLEEP_PATH } from "@dockify/contracts";
import { INFRA_POLICIES } from "../../policy.ts";

export const ASLEEP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This preview is asleep</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; font: 16px/24px system-ui, sans-serif; }
main { max-width: 440px; }
h1 { margin: 0 0 8px; font-size: 24px; line-height: 32px; font-weight: 600; }
p { margin: 0; opacity: .7; }
</style>
</head>
<body>
<main>
<h1>This preview is asleep</h1>
<p>It stopped after a while with no visitors, to save server resources. Push a commit to the pull request, or press Wake in the project's Previews tab, then reload this page.</p>
</main>
</body>
</html>
`;

export function registerPreviewAsleepRoute(app: FastifyInstance): void {
  app.get(PREVIEW_ASLEEP_PATH, { config: { policy: INFRA_POLICIES["GET /.well-known/dockify-preview-asleep"] } }, async (_req, reply) =>
    reply.code(503).header("retry-after", "60").header("cache-control", "no-store").header("x-robots-tag", "noindex").type("text/html; charset=utf-8").send(ASLEEP_PAGE),
  );
}
