/** The deployments module: `deploymentHandlers` goes in the bootstrap's handler table. */
import { deploymentHandlers } from "./handlers.ts";

export { deploymentHandlers };
export { enqueueDeployment } from "./enqueue.ts";
