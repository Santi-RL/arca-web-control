import path from "node:path";
import { buildSessionControlUrl, readCurrentSessionState } from "../src/arca/sessionState.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";
import { sanitizeErrorMessage } from "../src/arca/publicErrors.js";
import { loopbackTimeoutMs, requestLoopbackJson } from "../src/io/loopbackRequest.js";

try {
  const currentPath = path.join(getRuntimePaths().sessions, "current.json");
  const current = await readCurrentSessionState(currentPath);
  const response = await requestLoopbackJson(buildSessionControlUrl(current, "/stop"), {
    label: "el cierre de la sesión",
    timeoutMs: loopbackTimeoutMs.stop,
    mutation: true,
    init: { method: "POST", headers: { authorization: `Bearer ${current.token}` } },
  });
  console.log(JSON.stringify(response.payload, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
