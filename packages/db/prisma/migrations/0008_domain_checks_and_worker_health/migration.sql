-- Domain checks and the worker's own health report.
--
-- domains: the last DNS check's explanation in one line (dnsDetail), and the ownership probe's
-- outcome. A domain behind a proxy such as Cloudflare's resolves to the proxy and not to this
-- server, so the worker also asks the domain for a value only this server can give
-- (apps/worker/src/edge/probe.ts); a domain that answers counts as pointing here.
-- instance: problems the worker finds with itself that stop only part of its work, such as a work
-- folder it cannot write (workerIssues), written with its heartbeat for the server page and alerts.

-- CreateEnum
CREATE TYPE "DomainProbeStatus" AS ENUM ('untried', 'passed', 'failed');

-- AlterTable
ALTER TABLE "instance" ADD COLUMN     "workerIssues" JSONB;

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "dnsDetail" TEXT;

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "probeStatus" "DomainProbeStatus" NOT NULL DEFAULT 'untried';

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "probeDetail" TEXT;

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "probeCheckedAt" TIMESTAMPTZ(3);
