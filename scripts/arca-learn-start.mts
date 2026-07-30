import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureRuntimeLayout } from "../src/config/runtimePaths.js";
import { isProcessAlive } from "../src/io/processLock.js";
import { invalidCredentialsErrorFromLog, startupErrorFromLog } from "../src/arca/loginErrors.js";
import { buildLearningWorkerArgs, learningShutdownMessage } from "../src/learning/launcher.js";
import { readCurrentLearningStateIfExists } from "../src/learning/sessionState.js";

const values = process.argv.slice(2);
const runtime = await ensureRuntimeLayout();
const currentPath = path.join(runtime.learning, "current.json");
const launchId = randomUUID();
const existing = await readCurrentLearningStateIfExists(currentPath);
if (existing && isProcessAlive(existing.pid)) throw new Error(`Ya existe un aprendizaje ARCA activo (PID ${existing.pid}). Finalizalo o abortalo antes de iniciar otro.`);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const stdoutPath = path.join(runtime.logs, `arca-learn-${timestamp}.out.log`);
const stderrPath = path.join(runtime.logs, `arca-learn-${timestamp}.err.log`);
const out = fsSync.openSync(stdoutPath, "a"); const err = fsSync.openSync(stderrPath, "a");
const child = spawn(process.execPath, buildLearningWorkerArgs(path.resolve("scripts", "arca-learn.mts"), values), {
  detached: false,
  stdio: ["ignore", out, err, "ipc"],
  windowsHide: true,
  env: { ...process.env, ARCA_LEARN_LAUNCH_ID: launchId },
});
try {
  const deadline = Date.now() + 300000;
  let ready = false;
  while (Date.now() < deadline) {
    const current = await readCurrentLearningStateIfExists(currentPath).catch(() => undefined);
    if (child.pid !== undefined && current?.launchId === launchId && current.pid === child.pid && isProcessAlive(current.pid)) { ready = true; break; }
    if (child.exitCode !== null) throw await workerExitError();
    await delay(500);
  }
  if (!ready) {
    const finalCurrent = await readCurrentLearningStateIfExists(currentPath).catch(() => undefined);
    if (child.pid !== undefined && finalCurrent?.launchId === launchId && finalCurrent.pid === child.pid && isProcessAlive(finalCurrent.pid)) ready = true;
    else if (child.exitCode !== null) throw await workerExitError();
  }
  if (ready) {
    if (child.connected) child.disconnect();
    child.unref();
    console.log("READY_STATE=learning");
    console.log(`LEARNING_FILE=${currentPath}`);
    process.exitCode = 0;
  } else {
    if (child.exitCode === null && child.connected) child.send(learningShutdownMessage);
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(5000)]);
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(5000)]);
    const invalidCredentials = await readWorkerLog().then(invalidCredentialsErrorFromLog);
    if (child.exitCode === null) {
      throw new Error("No se pudo detener de forma controlada el aprendizaje vencido; se conservaron su estado y lock para revisión manual.");
    }
    if (invalidCredentials) throw invalidCredentials;
    throw new Error(`Timeout iniciando aprendizaje. Revisá ${stderrPath}`);
  }
} finally { fsSync.closeSync(out); fsSync.closeSync(err); }

async function workerExitError(): Promise<Error> {
  return startupErrorFromLog(await readWorkerLog(), `El aprendizaje terminó antes de quedar listo. Revisá ${stderrPath}`);
}

async function readWorkerLog(): Promise<string> {
  return fs.readFile(stderrPath, "utf8").then((value) => value.slice(-32_768)).catch(() => "");
}
