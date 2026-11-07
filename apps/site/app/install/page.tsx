import Link from "next/link";
import { Icon } from "@/components/icon";
import { Spacer } from "@/components/ui/rule";
import { PageHead } from "@/components/site/page-head";
import { CodeBlock, CommandLine } from "@/components/docs/code-block";
import { Body, Rows, Section, Steps } from "@/components/pages/kit";
import { Closer } from "@/components/pages/closer";
import { INSTALL_CMD, INSTALL_DRY_RUN_CMD, repoHref, UNINSTALL_CMD } from "@/lib/site";
import { pageMetadata } from "@/components/seo/metadata";

export const metadata = pageMetadata({
  path: "/install",
  absolute: "Install Dockify",
  description: "One command on a fresh Ubuntu server: it asks for your domain, sets up HTTPS and prints a one-time setup link.",
});

/* Paths, flags and messages are read from installer/install.sh and installer/uninstall.sh. */

const NEEDS = [
  { key: "os", term: "Server", desc: "A fresh Ubuntu 22.04 or 24.04 server, amd64 or arm64." },
  {
    key: "root",
    term: "Access",
    desc: (
      <>
        Root or sudo over SSH. The installer turns the ufw firewall on with incoming traffic denied. If SSH listens on a port other than 22, allow
        it first with <code className="pg-path">sudo ufw allow &lt;port&gt;/tcp</code>, or pass <code className="pg-path">--no-ufw</code>.
      </>
    ),
  },
  { key: "host", term: "Hostname", desc: <>A hostname for the dashboard, for example <code className="pg-path">dockify.example.com</code>.</> },
  {
    key: "cf",
    term: "Ingress",
    desc: "Your own domain for real use. To try it first: ports 80 and 443 free, and the dashboard starts on a temporary sslip.io address. For a Cloudflare tunnel, a domain and an API token with Zone DNS Edit and Cloudflare Tunnel Edit.",
  },
  {
    key: "size",
    term: "Size",
    desc: "Tested on 2 vCPU, 4 GB of memory and 49 GB of disk (Ubuntu 22.04). Leave room for your apps and their builds: BuildKit alone may use up to 4 GB while building.",
  },
];

const STEPS = [
  { title: "Checks the OS, your access, the architecture and free ports.", body: "It also stops if Dockify is already installed." },
  {
    title: "Turns on automatic security updates and sets up the firewall.",
    body: "The firewall denies incoming traffic and allows SSH, plus 80 and 443 in direct mode. Skip it with --no-ufw.",
    changes: ["/etc/apt/apt.conf.d/20auto-upgrades", "/etc/apt/apt.conf.d/52dockify-docker", "ufw"],
  },
  {
    title: "Installs Docker from Docker's signed repository if it is missing.",
    changes: ["/etc/apt/keyrings/docker.asc", "/etc/apt/sources.list.d/docker.list"],
  },
  { title: "Refuses a container runtime with known escape bugs.", body: "An old runc or containerd stops the install until it is updated." },
  {
    title: "Blocks containers from cloud metadata addresses and from reaching the host.",
    body: "The rules come back after every reboot.",
    changes: ["/usr/local/sbin/dockify-firewall", "dockify-firewall.service"],
  },
  {
    title: "Creates a new Cloudflare tunnel just for Dockify. It never reuses or deletes yours.",
    body: "The dashboard record is a CNAME with the comment \"managed by Dockify\". An existing record is only replaced with --replace-dns.",
    changes: ["tunnel dockify-<host>-<id>", "CNAME for --domain"],
  },
  { title: "Verifies the signed release and pulls images by digest.", body: "The manifest is checked with minisign against a pinned public key." },
  {
    title: "Writes secrets with generated values and starts the stack.",
    changes: ["/opt/dockify/.env", "/opt/dockify/secrets/", "/opt/dockify/release/", "/opt/dockify/uninstall.sh", "/usr/local/bin/dockify"],
  },
  { title: "Prints your setup link and a one-time setup token.", body: "It waits until the API answers its readiness check first." },
];

/* Every flag in the header of installer/install.sh. */
const FLAGS = [
  { key: "domain", term: "--domain HOST", desc: "Dashboard hostname. Omitted: asked for on the terminal; Enter, or no terminal, starts on a temporary sslip.io address." },
  { key: "ingress", term: "--ingress tunnel|direct", desc: "How traffic reaches the server. Default tunnel with --domain, direct on sslip.io." },
  { key: "cf-token", term: "--cf-token-file PATH", desc: "Cloudflare API token. Asked for when omitted and a terminal is attached." },
  { key: "cf-account", term: "--cf-account-id ID", desc: "Required when the token sees more than one account." },
  { key: "dns", term: "--replace-dns", desc: "Allow replacing an existing CNAME for --domain. Never other record types." },
  { key: "acme", term: "--acme-email EMAIL", desc: "Let's Encrypt account in direct mode. Omitted: asked for on the terminal; Enter, or no terminal, registers dockify@ the dashboard host." },
  { key: "dir", term: "--dir PATH", desc: "Install folder. Default /opt/dockify." },
  { key: "feed", term: "--release-feed URL", desc: "Signed feed base, https only. The manifest is URL/releases/stable.json." },
  { key: "pubkey", term: "--release-pubkey KEY", desc: "minisign public key, if not the pinned one." },
  { key: "images", term: "--control-image REF --web-image REF", desc: "Run these digest-pinned images instead of the feed. Self-update then needs a feed and key too." },
  { key: "ufw", term: "--no-ufw", desc: "Leave the host firewall alone." },
  { key: "vuln", term: "--allow-vulnerable-runtime", desc: "Warn instead of refusing on an old runc or containerd." },
  { key: "checkout", term: "--from-checkout", desc: "Take docker-compose.yml and the socket proxy config from the repository this script sits in, which must be root's alone." },
  { key: "dry", term: "--dry-run", desc: "Print the plan and change nothing. See the note under the command above." },
  { key: "upgrade", term: "--upgrade", desc: "Upgrade the install in --dir in place instead of installing. See Upgrade in the install docs." },
];

/* Every flag in the header of installer/uninstall.sh. */
const UNINSTALL_FLAGS = [
  { key: "dry", term: "--dry-run", desc: "Print the plan and change nothing." },
  { key: "yes", term: "--yes", desc: "Skip the confirmation prompts, for automation." },
  { key: "keep", term: "--keep-data", desc: "The default. Keeps Dockify's volumes and your apps' volumes and networks." },
  { key: "purge", term: "--purge", desc: "Also delete every Dockify volume, network and image. Asks a second time." },
  { key: "nobackup", term: "--no-backup", desc: "With --purge, skip the backup of the master key and secrets." },
  { key: "reboot", term: "--reboot", desc: "Reboot when done, so no firewall rule stays loaded." },
  { key: "dir", term: "--dir PATH", desc: "Install folder, if not /opt/dockify." },
  { key: "cf", term: "--cf-token-file PATH", desc: "Cloudflare token used to delete the tunnel and its DNS records. Asked for when omitted." },
];

/* The fallback when the script cannot run: the same removals, by hand, keeping your data. */
const UNINSTALL_BY_HAND = `sudo dockify down
sudo docker ps -aq --filter label=dockify.managed=true | xargs -r sudo docker rm -f
sudo docker ps -aq --filter label=dockify.app | xargs -r sudo docker rm -f
sudo systemctl disable --now dockify-firewall.service
sudo rm -f /etc/systemd/system/dockify-firewall.service /usr/local/sbin/dockify-firewall
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/dockify /etc/apt/apt.conf.d/52dockify-docker
sudo mkdir -m 700 /root/dockify-backup
sudo cp -a /opt/dockify/secrets /opt/dockify/.env /root/dockify-backup/
sudo rm -rf /opt/dockify
sudo reboot`;

export default function Page() {
  const script = repoHref("blob/main/installer/install.sh");
  return (
    <main id="main" className="page">
      <Spacer />
      <PageHead eyebrow="Install" title="Install Dockify" lead="One command on a fresh Ubuntu server. It asks for your dashboard's domain, sets up HTTPS and prints a one-time setup link." />
      <section className="phead-cmd">
        <CommandLine command={INSTALL_CMD} />
        <p className="phead-note">
          Want to see the plan first? This dry run changes nothing on the server. It still reads your Cloudflare account and needs jq and openssl
          already installed, so on a fresh server it can stop early.
        </p>
        <CommandLine command={INSTALL_DRY_RUN_CMD} what="dry run command" />
        <div className="pg-callout phead-callout" role="note">
          <Icon name="info" />
          <p>
            <strong>Dockify 1.0 is not released yet.</strong> This command works once the first signed release is out. Until then the installer
            stops early with &ldquo;no release source&rdquo;.
          </p>
        </div>
      </section>
      <Spacer />
      <Section id="needs" title="You need">
        <Rows items={NEEDS} />
      </Section>
      <Spacer />
      <Section id="steps" title="What the script does, in order" lead="Each step names the files and services it adds to your server.">
        <Steps items={STEPS} />
      </Section>
      <Spacer />
      <Section id="then" title="Then">
        <Body>
          <p>
            Open the link, paste the token, create your account. The dashboard is on HTTPS from the first minute, and in tunnel mode Dockify opens
            no inbound port; only SSH stays open. Nobody who finds your server first can claim it.
          </p>
          <div className="pg-callout" role="note">
            <Icon name="key" />
            <p>
              <strong>Back up the master key.</strong> It is at <code className="pg-path">/opt/dockify/secrets/master_key</code>. Without it,
              every stored secret and backup is unreadable.
            </p>
          </div>
        </Body>
      </Section>
      <Spacer />
      <Section id="flags" title="Flags" lead="Every flag in the header of install.sh. Pass them through the pipe after sh -s --.">
        <Rows items={FLAGS} mono />
      </Section>
      <Spacer />
      <Section
        id="uninstall"
        title="Uninstall"
        lead="One command removes everything the installer wrote. It shows the plan first and asks you to type your dashboard domain."
      >
        <Body>
          <CommandLine command={UNINSTALL_CMD} what="uninstall command" />
          <p>
            On the server itself, <code className="pg-path">sudo dockify uninstall</code> runs the same script. Add{" "}
            <code className="pg-path">--dry-run</code> to see the plan without changing anything. The{" "}
            <Link href="/docs/uninstall" className="link-inline">
              uninstall guide
            </Link>{" "}
            has the details.
          </p>
        </Body>
        <Rows items={UNINSTALL_FLAGS} mono />
        <Body className="pg-body-ruled">
          <p>
            It stops the stack, removes the apps Dockify deployed, the firewall service and its rules, the <code className="pg-path">dockify</code>{" "}
            command, the apt rule and <code className="pg-path">/opt/dockify</code>. In tunnel mode it deletes the{" "}
            <code className="pg-path">dockify-&lt;host&gt;-&lt;id&gt;</code> tunnel and the CNAME records pointing at it, with a Cloudflare token.
            Without one it prints exactly what to delete in the Cloudflare dashboard.
          </p>
          <p>
            <strong>Kept by default:</strong> Dockify&apos;s data volumes and your apps&apos; volumes and networks, each listed in the plan. Docker, ufw
            and automatic security updates always stay.
          </p>
          <div className="pg-callout" role="note">
            <Icon name="key" />
            <p>
              <strong>Your master key is backed up.</strong> Before <code className="pg-path">/opt/dockify</code> goes, the master key, the secrets
              folder and <code className="pg-path">.env</code> are copied to <code className="pg-path">/root/dockify-backup-&lt;time&gt;/</code>,
              readable by root only. With <code className="pg-path">--purge</code> the backup still runs unless you pass{" "}
              <code className="pg-path">--no-backup</code>.
            </p>
          </div>
          <p>Reboot afterwards, or pass <code className="pg-path">--reboot</code>, so no firewall rule stays loaded.</p>
        </Body>
      </Section>
      <Spacer />
      <Section
        id="uninstall-by-hand"
        title="Uninstall by hand"
        lead="If the script cannot run, these commands remove the same files and keep your data. Delete the tunnel and its CNAME in Cloudflare yourself."
      >
        <Body>
          <CodeBlock code={UNINSTALL_BY_HAND} lang="bash" />
        </Body>
      </Section>
      <Spacer />
      <Closer
        title="Want to read it first? The installer is one file."
        primary={{ href: "/docs/install", label: "Read the install guide", icon: "book" }}
        secondary={script ? { href: script, label: "View install.sh", external: true } : { href: "/installer.sh", label: "Download the installer", external: true }}
      />
      <Spacer end />
    </main>
  );
}
