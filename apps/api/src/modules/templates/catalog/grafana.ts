import type { Template } from "../format.ts";

export const grafana: Template = {
  id: "grafana",
  name: "Grafana",
  summary: "Dashboards for metrics and logs.",
  category: "Monitoring",
  icon: "grafana",
  license: "AGPL-3.0",
  homepage: "https://grafana.com",
  docs: "https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/",
  firstRun: "Sign in as admin with GF_SECURITY_ADMIN_PASSWORD, which you can reveal on its Variables tab. Dockify does not back up its volume.",
  primary: "grafana",
  memoryMb: {"grafana": 512},
  secrets: {"ADMIN_PASSWORD": "b64url24", "SECRET_KEY": "hex32"},
  inputs: [],
  compose: `services:
  grafana:
    image: grafana/grafana:13.2.5
    ports: ["3000"]
    volumes: ["data:/var/lib/grafana"]
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
      GF_SECURITY_SECRET_KEY: "{{secret.SECRET_KEY}}"
      GF_SERVER_ROOT_URL: "{{url}}"
volumes:
  data:
`,
};
