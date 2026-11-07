import { describe, expect, it } from "vitest";
import { NewDbName } from "./backups.ts";
import { AppName, Hostname, RESERVED_NAME_PREFIX } from "./common.ts";
import { nonPublicHostReason } from "./public-host.ts";

describe("names that can never be public", () => {
  it("refuses special-use and private suffixes, single labels and IP literals", () => {
    for (const h of [
      "metadata.google.internal", "printer.local", "app.localhost", "localhost", "x.test", "a.invalid", "site.example",
      "hidden.onion", "1.0.0.10.in-addr.arpa", "router.home.arpa", "nas.lan", "box.localdomain", "wiki.intranet", "erp.corp",
      "pc.home", "db.private", "intranet", "10.0.0.1", "::1", "[2001:db8::1]", "Metadata.Google.Internal.",
    ]) expect(nonPublicHostReason(h), h).not.toBeNull();
  });

  it("passes ordinary public names, including ones that only look close", () => {
    for (const h of ["shop.example.com", "example.com", "dockify.203-0-113-10.sslip.io", "local.example.org", "internal-tools.dev", "my.corporate.net", "app.homes"]) {
      expect(nonPublicHostReason(h), h).toBeNull();
    }
  });

  it("is consistent with the Hostname grammar, which already keeps out IP literals and single labels", () => {
    expect(Hostname.safeParse("10.0.0.1").success).toBe(false);
    expect(Hostname.safeParse("intranet").success).toBe(false);
    expect(Hostname.safeParse("metadata.google.internal").success).toBe(true);
    expect(nonPublicHostReason("metadata.google.internal")).toMatch(/\.internal/);
  });
});

describe("reserved app names", () => {
  it("keeps the dk- prefix for Dockify's own container names and aliases", () => {
    expect(RESERVED_NAME_PREFIX).toBe("dk-");
    expect(AppName.safeParse("dk-route").success).toBe(false);
    expect(AppName.safeParse("dk-0f0e0d0c").success).toBe(false);
    expect(AppName.safeParse("web").success).toBe(true);
    expect(AppName.safeParse("dkb").success).toBe(true);
    expect(AppName.safeParse("my-dk-app").success).toBe(true);
  });

  it("holds for a database restored into a new service too, whose name is also its alias", () => {
    // 39 characters: exactly the shape of an app's canonical name, dk-<app id>.
    expect(NewDbName.safeParse("dk-0f0e0d0c-0000-4000-8000-0000000000aa").success).toBe(false);
    expect(NewDbName.safeParse("orders-restored").success).toBe(true);
  });
});
