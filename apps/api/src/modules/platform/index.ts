import type { Handlers } from "../../app.ts";
import { activityHandlers } from "./activity.ts";
import { serverHandlers } from "./server.ts";
import { settingsHandlers } from "./settings.ts";
import { loadPlatformEnv, type PlatformEnv } from "./shared.ts";
import { teamHandlers } from "./team.ts";
import { tokenHandlers } from "./tokens.ts";

export function platformHandlers(env: PlatformEnv = loadPlatformEnv()): Handlers {
  return { ...teamHandlers, ...settingsHandlers, ...tokenHandlers, ...activityHandlers, ...serverHandlers(env) };
}
