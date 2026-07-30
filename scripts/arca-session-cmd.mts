import path from "node:path";
import { parseSessionCommandArgs } from "../src/arca/sessionCommands.js";
import { buildSessionControlUrl, readCurrentSessionState } from "../src/arca/sessionState.js";
import { getRuntimePaths, useActiveSessionRuntimeLayout } from "../src/config/runtimePaths.js";
import { requestLoopbackJson, sessionCommandTimeoutMs } from "../src/io/loopbackRequest.js";
import { sanitizeErrorMessage } from "../src/arca/publicErrors.js";

const runtime = getRuntimePaths();
const currentPath = path.join(runtime.sessions, "current.json");
try {
  const command = parseSessionCommandArgs(process.argv.slice(2));
  if (command.type !== "status") await useActiveSessionRuntimeLayout(runtime);
  const current = await readCurrentSessionState(currentPath);
  const response = await requestLoopbackJson(buildSessionControlUrl(current, "/command"), {
    label: `el comando ${command.type}`,
    timeoutMs: sessionCommandTimeoutMs(command),
    mutation: command.type !== "status",
    init: { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${current.token}` }, body: JSON.stringify({ command }) },
  });
  console.log(JSON.stringify(response.payload, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
  console.error(message); process.exitCode = 1;
}
