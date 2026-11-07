import type { Template } from "../format.ts";

export const mattermost: Template = {
  id: "mattermost",
  name: "Mattermost",
  summary: "Team chat you run yourself.",
  category: "Collaboration",
  icon: "mattermost",
  license: "MIT for the Team Edition binaries",
  homepage: "https://mattermost.com",
  docs: "https://docs.mattermost.com/deployment-guide/server/deploy-containers.html",
  firstRun: "The first account you create becomes the system admin. Do that before you share the address. Voice calls need UDP, which Dockify does not route. It reserves 2 GB of memory.",
  primary: "mattermost",
  memoryMb: {"mattermost": 2048},
  secrets: {},
  inputs: [],
  compose: `services:
  mattermost:
    image: mattermost/mattermost-team-edition:12.1.0
    ports: ["8065"]
    volumes: ["config:/mattermost/config", "data:/mattermost/data", "logs:/mattermost/logs", "plugins:/mattermost/plugins", "client-plugins:/mattermost/client/plugins"]
    environment:
      MM_SQLSETTINGS_DRIVERNAME: postgres
      MM_SQLSETTINGS_DATASOURCE: "{{ref.db.urlNoTls}}"
      MM_SERVICESETTINGS_SITEURL: "{{url}}"
  db:
    image: postgres:17
volumes:
  config:
  data:
  logs:
  plugins:
  client-plugins:
`,
};
