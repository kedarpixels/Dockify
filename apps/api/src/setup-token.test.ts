/** The setup wizard's token check says which of the two it is: no token, or a wrong one (found on the test box). */
import { describe, expect, it } from "vitest";
import type { Ctx } from "./app.ts";
import { authHandlers } from "./routes/auth.ts";
import { testConfig } from "./test-helpers.ts";

const ctx = { db: {}, config: testConfig({ setupToken: "the-right-token-0123456789" }), web: { origin: "https://dockify.test", secure: true } } as unknown as Ctx;
const setup = (setupToken?: string) =>
  (authHandlers["auth.setup"] as (i: object) => Promise<unknown>)({ ctx, req: {}, reply: {}, body: { instanceName: "Test", name: "Owner", email: "o@example.com", password: "correct horse battery", ...(setupToken === undefined ? {} : { setupToken }) } });

describe("the setup token", () => {
  it("asks for the token when none was given", async () => {
    await expect(setup()).rejects.toMatchObject({ status: 403, code: "SETUP_TOKEN", message: "This server needs the setup token the installer printed" });
  });
  it("says a wrong token is wrong, and where the right one is kept", async () => {
    await expect(setup("not-the-token")).rejects.toMatchObject({ status: 403, code: "SETUP_TOKEN", message: expect.stringMatching(/^That setup token is not right\..*secrets\/setup_token/) });
  });
});
