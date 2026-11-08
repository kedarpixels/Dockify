import { describe, expect, it } from "vitest";
import { DEV_VERSION, runningVersion } from "./version.ts";

describe("runningVersion", () => {
  it("is the image's own version, whatever a stale .env says after an in-app update", () => {
    // 1.0.1 installed by hand, then updated in the app to 1.0.2: .env still names 1.0.1.
    expect(runningVersion({ DOCKIFY_IMAGE_VERSION: "1.0.2", DOCKIFY_VERSION: "1.0.1" })).toBe("1.0.2");
  });
  it("falls back to DOCKIFY_VERSION only for an image with no baked version, then to the dev version", () => {
    expect(runningVersion({ DOCKIFY_VERSION: "1.0.1" })).toBe("1.0.1");
    expect(runningVersion({ DOCKIFY_IMAGE_VERSION: "  ", DOCKIFY_VERSION: "" })).toBe(DEV_VERSION);
    expect(runningVersion({})).toBe("0.0.0-dev");
  });
});
