import type { Template } from "../format.ts";

export const listmonk: Template = {
  id: "listmonk",
  name: "listmonk",
  summary: "Newsletters and mailing lists.",
  category: "Business",
  icon: "listmonk",
  license: "AGPL-3.0",
  homepage: "https://listmonk.app",
  docs: "https://listmonk.app/docs/installation/",
  firstRun: "Sign in as admin with LISTMONK_ADMIN_PASSWORD, which you can reveal on its Variables tab. Set up SMTP in its Settings before you send anything.",
  primary: "listmonk",
  memoryMb: {"listmonk": 256},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [],
  compose: `services:
  listmonk:
    image: listmonk/listmonk:v6.2.0
    command: ./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''
    ports: ["9000"]
    volumes: ["uploads:/listmonk/uploads"]
    environment:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: "{{ref.db.host}}"
      LISTMONK_db__port: "{{ref.db.port}}"
      LISTMONK_db__user: "{{ref.db.user}}"
      LISTMONK_db__password: "{{ref.db.password}}"
      LISTMONK_db__database: "{{ref.db.database}}"
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: admin
      LISTMONK_ADMIN_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
  db:
    image: postgres:17
volumes:
  uploads:
`,
};
