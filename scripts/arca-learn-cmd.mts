import path from "node:path";
import { getRuntimePaths } from "../src/config/runtimePaths.js";
import { parseLearningCommandArgs } from "../src/learning/commands.js";
import { buildLearningControlUrl, readCurrentLearningState } from "../src/learning/sessionState.js";

const currentPath = path.join(getRuntimePaths().learning, "current.json");
const current = await readCurrentLearningState(currentPath);
const commandArgs = process.argv.slice(2);
const privateInputValue = commandArgs[0] === "fill-input" ? await readPrivateStdin() : undefined;
const command = parseLearningCommandArgs(commandArgs, privateInputValue);
const response = await fetch(buildLearningControlUrl(current), { method: "POST", headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: JSON.stringify(command) });
const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
if (!response.ok) process.exitCode = 1;

async function readPrivateStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 2048) throw new Error("El valor privado supera el tamaño permitido.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
