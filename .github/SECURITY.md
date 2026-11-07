# Security policy

Dockify runs with root-level reach over a server and holds its operators' secrets, so reports are
taken seriously and handled privately.

## Report a vulnerability

Use GitHub private vulnerability reporting: on the repository's Security tab, choose "Report a
vulnerability" (https://github.com/kedarpixels/Dockify/security/advisories/new). Only the
maintainers see the report.

Please do not open a public issue. Include what you found, how to reproduce it, the version, and
what an attacker gains. You will get an answer as soon as someone has read and checked it, and
credit in the release notes if you want it.

## What is covered

The control plane in this repository: the api, worker, agent, gate, updater, dashboard and installer.
Apps people deploy on Dockify are theirs to secure.

Fixes go to the latest release. Dockify's update feed marks a security release, and the dashboard
tells admins about it.

## How to verify a release

Releases are signed with minisign. The installer and the updater check the signature against the key
pinned in the release. `docs/RELEASING.md` describes the chain.

`docs/ARCHITECTURE.md` states the security model and what a compromise of each part is worth.
