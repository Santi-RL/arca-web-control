import path from "node:path";
import { parseSessionCommandArgs } from "../src/arca/sessionCommands.js";
import { buildSessionControlUrl, readCurrentSessionState } from "../src/arca/sessionState.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";

const currentPath = path.join(getRuntimePaths().sessions, "current.json");
try {
  const command = parseSessionCommandArgs(process.argv.slice(2));
  const current = await readCurrentSessionState(currentPath);
  const response = await fetch(buildSessionControlUrl(current, "/command"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${current.token}` }, body: JSON.stringify({ command }) });
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message); process.exitCode = 1;
}
