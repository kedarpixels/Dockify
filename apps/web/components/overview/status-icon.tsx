import type { IconName } from "@/components/icon";
import { StatusMark } from "@/components/ui/status-mark";
import { DEPLOY_LABEL, DEPLOY_TONE } from "@/lib/derive";
import type { RecentDeployment } from "@/lib/types";

const GLYPH: Partial<Record<RecentDeployment["status"], IconName>> = {
  ready: "check",
  failed: "close",
  cancelled: "slash",
};

/**
 * A deployment's status mark (StatusMark): ready is a green check, failed a red cross, cancelled a
 * grey slash, building and deploying a blue spinner, queued a slower amber spinner.
 */
export function StatusIcon({ status }: { status: RecentDeployment["status"] }) {
  return <StatusMark tone={DEPLOY_TONE[status]} label={DEPLOY_LABEL[status]} icon={GLYPH[status]} />;
}
