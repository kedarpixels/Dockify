import type { Template } from "../format.ts";

export const miniflux: Template = {
  id: "miniflux",
  name: "Miniflux",
  summary: "A minimal feed reader.",
  category: "Content",
  icon: "",
  license: "Apache-2.0",
  homepage: "https://miniflux.app",
  docs: "https://miniflux.app/docs/docker.html",
  firstRun: "Sign in as admin with ADMIN_PASSWORD, which you can reveal on its Variables tab.",
  primary: "miniflux",
  memoryMb: {"miniflux": 128},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [],
  compose: `services:
  miniflux:
    image: miniflux/miniflux:2.3.5
    ports: ["8080"]
    environment:
      DATABASE_URL: "{{ref.db.urlNoTls}}"
      RUN_MIGRATIONS: "1"
      CREATE_ADMIN: "1"
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
      BASE_URL: "{{url}}"
      HTTPS: "1"
  db:
    image: postgres:17
`,
};
