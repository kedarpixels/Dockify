import type { Template } from "../format.ts";

export const gitea: Template = {
  id: "gitea",
  name: "Gitea",
  summary: "Git hosting with pull requests and issues.",
  category: "Developer tools",
  icon: "gitea",
  license: "MIT",
  homepage: "https://about.gitea.com",
  docs: "https://docs.gitea.com/installation/install-with-docker-rootless",
  firstRun: "The first account to register becomes the admin, and registration stays open until you close it. Register now. Clone over HTTPS: SSH is off because only one port is routed.",
  primary: "gitea",
  memoryMb: {"gitea": 512},
  secrets: {"SECRET_KEY": "hex32"},
  inputs: [],
  compose: `services:
  gitea:
    image: gitea/gitea:28.3-rootless
    ports: ["3000"]
    volumes: ["data:/var/lib/gitea"]
    environment:
      GITEA_APP_INI: /var/lib/gitea/custom/conf/app.ini
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: "{{ref.db.host}}"
      GITEA__database__NAME: "{{ref.db.database}}"
      GITEA__database__USER: "{{ref.db.user}}"
      GITEA__database__PASSWD: "{{ref.db.password}}"
      GITEA__database__SSL_MODE: disable
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__security__SECRET_KEY: "{{secret.SECRET_KEY}}"
      GITEA__server__ROOT_URL: "{{url}}"
      GITEA__server__DOMAIN: "{{hostname}}"
      GITEA__server__DISABLE_SSH: "true"
      GITEA__server__START_SSH_SERVER: "false"
  db:
    image: postgres:17
volumes:
  data:
`,
};
