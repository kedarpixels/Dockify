import type { Template } from "../format.ts";

export const wikijs: Template = {
  id: "wikijs",
  name: "Wiki.js",
  summary: "A wiki with a modern editor.",
  category: "Collaboration",
  icon: "wikidotjs",
  license: "AGPL-3.0",
  homepage: "https://js.wiki",
  docs: "https://docs.requarks.io/install/docker",
  firstRun: "The setup page creates the admin account. Do that before you share the address.",
  primary: "wiki",
  memoryMb: {"wiki": 512},
  secrets: {},
  inputs: [],
  compose: `services:
  wiki:
    image: requarks/wiki:2.5
    ports: ["3000"]
    environment:
      DB_TYPE: postgres
      DB_HOST: "{{ref.db.host}}"
      DB_PORT: "{{ref.db.port}}"
      DB_USER: "{{ref.db.user}}"
      DB_PASS: "{{ref.db.password}}"
      DB_NAME: "{{ref.db.database}}"
  db:
    image: postgres:17
`,
};
