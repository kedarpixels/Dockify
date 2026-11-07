import type { Template } from "../format.ts";

export const ntfy: Template = {
  id: "ntfy",
  name: "ntfy",
  summary: "Push notifications over simple HTTP calls.",
  category: "Monitoring",
  icon: "ntfy",
  license: "Apache-2.0 or GPL-2.0",
  homepage: "https://ntfy.sh",
  docs: "https://docs.ntfy.sh/config/",
  firstRun: "There is no login: anyone who has the address can publish and subscribe until you set up access control in its docs.",
  primary: "ntfy",
  memoryMb: {"ntfy": 128},
  secrets: {},
  inputs: [],
  compose: `services:
  ntfy:
    image: binwiederhier/ntfy:v2.37.2
    command: ntfy serve
    ports: ["80"]
    volumes: ["data:/var/lib/ntfy"]
    environment:
      NTFY_BASE_URL: "{{url}}"
      NTFY_BEHIND_PROXY: "true"
      NTFY_CACHE_FILE: /var/lib/ntfy/cache.db
      NTFY_AUTH_FILE: /var/lib/ntfy/auth.db
      NTFY_ATTACHMENT_CACHE_DIR: /var/lib/ntfy/attachments
volumes:
  data:
`,
};
