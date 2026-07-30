import path from "node:path";
import { getRuntimePaths, useActiveSessionRuntimeLayout } from "../src/config/runtimePaths.js";
import { parseLearningCommandArgs } from "../src/learning/commands.js";
import { buildLearningControlUrl, readCurrentLearningState } from "../src/learning/sessionState.js";
import { publicLearningError } from "../src/learning/publicError.js";
import { learningCommandTimeoutMs, requestLoopbackJson } from "../src/io/loopbackRequest.js";

try {
  const runtime = getRuntimePaths();
  const currentPath = path.join(runtime.learning, "current.json");
  const commandArgs = process.argv.slice(2);
  if (commandArgs[0] !== "status" && commandArgs[0] !== "abort") await useActiveSessionRuntimeLayout(runtime);
  const privateInputValue = commandArgs[0] === "fill-input" ? await readPrivateStdin() : undefined;
  const command = parseLearningCommandArgs(commandArgs, privateInputValue);
  const current = await readCurrentLearningState(currentPath);
  const response = await requestLoopbackJson(buildLearningControlUrl(current), {
    label: `el comando de aprendizaje ${command.type}`,
    timeoutMs: learningCommandTimeoutMs(command),
    mutation: command.type !== "status" && command.type !== "inspect",
    init: { method: "POST", headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: JSON.stringify(command) },
  });
  console.log(JSON.stringify(response.payload, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(publicLearningError(process.argv[2], error));
  process.exitCode = 1;
}

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
