"use client";

import { useState } from "react";
import { Icon, type IconSize } from "@/components/icon";
import { PROVIDER_ICON, webhookIconUrl, type WebhookRef } from "@/lib/webhooks";

/** Falls back to the webhook glyph when no image loads. Decorative: the name is always printed or announced beside it. */
export function WebhookMark({ webhook, size = 16 }: { webhook: Pick<WebhookRef, "id" | "provider" | "icon">; size?: IconSize }) {
  const image = webhook.provider === "generic" ? webhook.icon.image : null;
  const src = image ? webhookIconUrl(webhook.id, image.version) : null;
  const [failed, setFailed] = useState<string | null>(null);
  // The API checked the bytes and rebuilt any SVG; an img never runs what an SVG could carry anyway.
  if (src && failed !== src) {
    return <img className="wh-logo" src={src} width={size} height={size} alt="" decoding="async" draggable={false} onError={() => setFailed(src)} />;
  }
  return <Icon name={PROVIDER_ICON[webhook.provider]} size={size} />;
}
