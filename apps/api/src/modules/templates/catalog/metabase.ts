import type { Template } from "../format.ts";

export const metabase: Template = {
  id: "metabase",
  name: "Metabase",
  summary: "Dashboards and questions over your data.",
  category: "Analytics",
  icon: "metabase",
  license: "AGPL-3.0",
  homepage: "https://www.metabase.com",
  docs: "https://www.metabase.com/docs/latest/installation-and-operation/running-metabase-on-docker",
  firstRun: "The setup wizard creates the admin account. Do that before you share the address.",
  primary: "metabase",
  memoryMb: {"metabase": 1536},
  secrets: {"MB_ENCRYPTION_SECRET_KEY": "b64url32"},
  inputs: [],
  compose: `services:
  metabase:
    image: metabase/metabase:v0.65.3
    ports: ["3000"]
    environment:
      MB_DB_TYPE: postgres
      MB_DB_DBNAME: "{{ref.db.database}}"
      MB_DB_PORT: "{{ref.db.port}}"
      MB_DB_USER: "{{ref.db.user}}"
      MB_DB_PASS: "{{ref.db.password}}"
      MB_DB_HOST: "{{ref.db.host}}"
      MB_ENCRYPTION_SECRET_KEY: "{{secret.MB_ENCRYPTION_SECRET_KEY}}"
  db:
    image: postgres:17
`,
};
