import type { IconName } from "@/components/icon";
import { StatusMark } from "@/components/ui/status-mark";
import { DEPLOY_LABEL, DEPLOY_TONE } from "@/lib/derive";
import type { RecentDeployment } from "@/lib/types";

const GLYPH: Partial<Record<RecentDeployment["status"], IconName>> = {
  ready: "check",
  failed: "close",
  cancelled: "slash",
};

export function StatusIcon({ status }: { status: RecentDeployment["status"] }) {
  return <StatusMark tone={DEPLOY_TONE[status]} label={DEPLOY_LABEL[status]} icon={GLYPH[status]} />;
}
