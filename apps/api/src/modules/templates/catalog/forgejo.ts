import type { Template } from "../format.ts";

export const forgejo: Template = {
  id: "forgejo",
  name: "Forgejo",
  summary: "Community run Git hosting.",
  category: "Developer tools",
  icon: "forgejo",
  license: "GPL-3.0-or-later",
  homepage: "https://forgejo.org",
  docs: "https://forgejo.org/docs/latest/admin/installation/docker/",
  firstRun: "The first account to register becomes the admin, and registration stays open until you close it. Register now. Clone over HTTPS: SSH is off because only one port is routed.",
  primary: "forgejo",
  memoryMb: {"forgejo": 512},
  secrets: {"SECRET_KEY": "hex32"},
  inputs: [],
  compose: `services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:17-rootless
    ports: ["3000"]
    volumes: ["data:/var/lib/gitea"]
    environment:
      FORGEJO__database__DB_TYPE: postgres
      FORGEJO__database__HOST: "{{ref.db.host}}"
      FORGEJO__database__NAME: "{{ref.db.database}}"
      FORGEJO__database__USER: "{{ref.db.user}}"
      FORGEJO__database__PASSWD: "{{ref.db.password}}"
      FORGEJO__security__INSTALL_LOCK: "true"
      FORGEJO__security__SECRET_KEY: "{{secret.SECRET_KEY}}"
      FORGEJO__server__ROOT_URL: "{{url}}"
      FORGEJO__server__DOMAIN: "{{hostname}}"
      FORGEJO__server__DISABLE_SSH: "true"
      FORGEJO__server__START_SSH_SERVER: "false"
  db:
    image: postgres:17
volumes:
  data:
`,
};
