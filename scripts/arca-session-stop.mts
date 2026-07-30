import path from "node:path";
import { buildSessionControlUrl, readCurrentSessionState } from "../src/arca/sessionState.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";

const currentPath = path.join(getRuntimePaths().sessions, "current.json");
const current = await readCurrentSessionState(currentPath);
const response = await fetch(buildSessionControlUrl(current, "/stop"), { method: "POST", headers: { authorization: `Bearer ${current.token}` } });
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
