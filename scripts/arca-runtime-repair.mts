import { getRuntimePaths, repairManagedRuntimeAcl } from "../src/config/runtimePaths.js";
import { acquireRuntimeMaintenanceTransition, assertNoLiveRuntimeActivity } from "../src/config/runtimeMaintenance.js";

const values = process.argv.slice(2);
if (values.length !== 2 || values[0] !== "--write" || values[1] !== "REPARAR_RUNTIME") {
  throw new Error("Uso: arca:runtime:repair -- --write REPARAR_RUNTIME");
}

const runtime = getRuntimePaths();
const releaseTransition = await acquireRuntimeMaintenanceTransition(runtime);
try {
  await assertNoLiveRuntimeActivity(runtime);
  await repairManagedRuntimeAcl(runtime);
  console.log("RUNTIME_REPAIRED=1");
} finally {
  await releaseTransition();
}
