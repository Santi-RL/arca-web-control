import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveCredentialRoutingIdentity } from "../src/config/env.js";
import { ensureRuntimeLayout, getRuntimePaths } from "../src/config/runtimePaths.js";
import { acquireRuntimeMaintenanceTransition } from "../src/config/runtimeMaintenance.js";
import { readJsonIfExists } from "../src/io/atomicJson.js";
import { requireHiddenCapability, requireVisibleInvoiceRevalidationCapability } from "../src/capabilities/registry.js";
import { SessionVisibilityMode } from "../src/types.js";
import { attestSessionRuntimeToWorker, buildSessionWorkerArgs, isSessionHandoffAckMessage, retrySessionStatus, sessionHandoffMessage, sessionLauncherHandoffEnv, sessionShutdownMessage, sessionStatusPayloadFromHttp, waitForSessionPublished } from "../src/arca/sessionLauncher.js";
import { startupErrorFromLog } from "../src/arca/loginErrors.js";
import { measureArcaPerformance } from "../src/arca/performance.js";
import { buildSessionControlUrl, readCurrentSessionStateIfExists, type CurrentSessionState } from "../src/arca/sessionState.js";
import { credentialProviderFingerprint, sessionCredentialProviderFingerprintEnv } from "../src/config/credentialProvider.js";
import { assertVisibleRevalidationAvailable } from "../src/arca/visibleRevalidationGuard.js";
import { CaptchaRequiredError } from "../src/arca/captchaErrors.js";

type Args = { forceNew: boolean; issuer: string; visibilityMode: SessionVisibilityMode; learnedCapability?: string; revalidationCapability?: string; timeoutMs: number };
let currentPath = "";
let lockPath = "";
let outPath = "";
let errPath = "";

await runSessionStart();

async function runSessionStart(): Promise<void> {
const runtimeCandidate = getRuntimePaths();
const releaseRuntimeTransition = await acquireRuntimeMaintenanceTransition(runtimeCandidate);
try {
const args = parseArgs(process.argv.slice(2));
const runtime = await measureArcaPerformance("launcher_runtime", async () => await ensureRuntimeLayout(runtimeCandidate));
const providerFingerprint = credentialProviderFingerprint(runtime);
const issuerIdentity = await measureArcaPerformance("launcher_identity", async () => resolveCredentialRoutingIdentity(args.issuer));
if (args.visibilityMode === "production-hidden") await requireHiddenCapability(args.learnedCapability || "");
const revalidationManifest = args.revalidationCapability
  ? await requireVisibleInvoiceRevalidationCapability(args.revalidationCapability)
  : undefined;
if (revalidationManifest) await assertVisibleRevalidationAvailable(revalidationManifest);
currentPath = path.join(runtime.sessions, "current.json");
lockPath = path.join(runtime.sessions, "current.lock");
const existing = await readCurrentSessionStateIfExists(currentPath);
if (existing) {
  const status = await fetchStatus(existing);
  if (!status) {
    throw new Error("Existe un estado de sesión huérfano. Verificá que el PID haya terminado y retiralo junto con current.lock de forma manual antes de iniciar otra sesión.");
  }
  if (status.busy === true) {
    throw new Error("La sesión ARCA está viva y procesando otro comando; no se inició, cerró ni reinició ninguna sesión.");
  }
  const same = existing.issuerKey === issuerIdentity.issuerKey && existing.visibilityMode === args.visibilityMode && existing.learnedCapability === args.learnedCapability && existing.revalidationCapability === args.revalidationCapability;
  if (!args.forceNew && same && existing.handoffComplete === true && status.state?.readyState === "portal" && !status.state.captchaVisible && status.state.revalidationConsumed !== true) { printReady(existing, status, true); process.exitCode = 0; return; }
  if (!args.forceNew) throw new Error("Ya existe una sesión viva. Usá arca:session:stop o --force-new para cerrarla de forma controlada.");
  await stop(existing);
  await waitUntilStopped(existing.pid, 15000);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
outPath = path.join(runtime.logs, `arca-session-${timestamp}.out.log`); errPath = path.join(runtime.logs, `arca-session-${timestamp}.err.log`);
const out = fsSync.openSync(outPath, "a"); const err = fsSync.openSync(errPath, "a");
const childArgs = buildSessionWorkerArgs({
  scriptPath: path.resolve("scripts", "arca-session.mts"),
  issuer: issuerIdentity.issuerKey,
  productionHidden: args.visibilityMode === "production-hidden",
  capability: args.learnedCapability,
  revalidationCapability: args.revalidationCapability,
});
const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", out, err, "ipc"], windowsHide: true, env: { ...process.env, [sessionLauncherHandoffEnv]: "1", [sessionCredentialProviderFingerprintEnv]: providerFingerprint } });
const publishedSession = waitForSessionPublished(child, args.timeoutMs);
try {
  const runtimeAcknowledged = await measureArcaPerformance("launcher_runtime_handoff", async () => attestSessionRuntimeToWorker(child, runtime.root));
  if (!runtimeAcknowledged) throw new Error("El worker no confirmó la atestación del runtime privado.");
  const startupOutcome = await measureArcaPerformance("launcher_spawn_ready", async (): Promise<"ready" | "captcha"> => {
    const publishedPid = await publishedSession;
    if (!publishedPid) {
      if (child.exitCode !== null || child.signalCode !== null) throw await sessionWorkerExitError();
      throw new Error("El worker no publicó una sesión lista dentro del plazo. Revisá el log privado de la sesión en el runtime local.");
    }
    if (!child.pid || publishedPid !== child.pid) throw new Error("El worker publicó un PID que no coincide con el proceso iniciado.");
    const current = await readCurrentSessionStateIfExists(currentPath).catch(() => undefined);
    if (!current || current.pid !== child.pid) throw new Error("El worker anunció la sesión, pero current.json no pertenece al proceso iniciado.");
    const status = await fetchStatus(current);
    if (!status) throw new Error("El worker anunció la sesión, pero su endpoint local de estado no respondió.");
    if (status.state?.captchaVisible) {
      if (!await completeIpcHandoff(child)) throw new Error("El worker quedó pausado por captcha, pero no confirmó el handoff de la sesión visible.");
      child.unref();
      console.error(new CaptchaRequiredError().message);
      return "captcha";
    }
    if (status.state?.readyState !== "portal") throw new Error(`El worker publicó un estado no listo (${status.state?.readyState ?? "desconocido"}).`);
    if (!await completeIpcHandoff(child)) throw new Error("El worker llegó al portal, pero no confirmó el handoff de la sesión.");
    child.unref();
    printReady(current, status, false);
    return "ready";
  });
  process.exitCode = startupOutcome === "captcha" ? 2 : 0;
} catch (error) {
  try {
    await terminateWorker(child);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "La sesión falló y el worker no pudo cerrarse de forma verificable.");
  }
  throw error;
} finally { fsSync.closeSync(out); fsSync.closeSync(err); }
} finally {
  await releaseRuntimeTransition();
}
}

function parseArgs(values: string[]): Args { const get = (name: string) => { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined; }; const issuer = get("--issuer"); if (!issuer) throw new Error("Falta --issuer."); const timeoutMs = Number(get("--timeout-ms") || 180000); if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms inválido."); const visibilityMode: SessionVisibilityMode = values.includes("--production-hidden") ? "production-hidden" : "visible"; const learnedCapability = get("--capability"); const revalidationCapability = get("--revalidate-irreversible"); if (visibilityMode === "production-hidden" && !learnedCapability) throw new Error("Falta --capability."); if (revalidationCapability && (visibilityMode !== "visible" || learnedCapability)) throw new Error("--revalidate-irreversible requiere una sesión visible exclusiva."); return { forceNew: values.includes("--force-new"), issuer, visibilityMode, learnedCapability, revalidationCapability, timeoutMs }; }
async function fetchStatus(current: CurrentSessionState): Promise<any | undefined> { return await retrySessionStatus(async () => { try { const response = await fetch(buildSessionControlUrl(current, "/status"), { headers: { authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(1000) }); const payload = await response.json().catch(() => undefined); return sessionStatusPayloadFromHttp(response.status, payload); } catch { return undefined; } }, 5000, 100); }
async function stop(current: CurrentSessionState): Promise<void> { const response = await fetch(buildSessionControlUrl(current, "/stop"), { method: "POST", headers: { authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error("No se pudo cerrar la sesión anterior de forma controlada."); }
async function waitUntilStopped(pid: number, timeout: number): Promise<void> { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await delay(250); } throw new Error("La sesión anterior no terminó dentro del plazo."); }
function printReady(current: CurrentSessionState, status: any, already: boolean): void { console.log(`READY_URL=${status.state.url}`); console.log("READY_STATE=portal"); console.log(`CAPTCHA_VISIBLE=${status.state.captchaVisible}`); console.log(`SESSION_ALREADY_ACTIVE=${already}`); console.log(`SESSION_PID=${current.pid}`); console.log(`SESSION_FILE=${currentPath}`); console.log("HANDOFF=Sesión lista. Responder al usuario y esperar el próximo pedido."); }

async function terminateWorker(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const current = await readCurrentSessionStateIfExists(currentPath).catch(() => undefined);
  let stopRequested = false;
  if (current?.pid === pid) stopRequested = await stop(current).then(() => true).catch(() => false);
  if (!stopRequested) stopRequested = await requestIpcShutdown(child);
  if (!stopRequested) {
    forceKillWorkerTree(child, pid);
    if (!await waitForWorkerTreeExit(child, pid, 5000)) throw new Error(`El árbol del worker de sesión PID ${pid} no terminó.`);
  } else if (!await waitForChildExit(child, 20_000)) {
    forceKillWorkerTree(child, pid);
    if (!await waitForWorkerTreeExit(child, pid, 5000)) throw new Error(`El árbol del worker de sesión PID ${pid} no terminó.`);
  }
  await removeOwnedRuntimeState(pid);
}

async function completeIpcHandoff(child: ChildProcess): Promise<boolean> {
  if (!child.connected || !child.send) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (acknowledged: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      if (acknowledged && child.connected) child.disconnect();
      resolve(acknowledged);
    };
    const onMessage = (message: unknown) => { if (isSessionHandoffAckMessage(message)) finish(true); };
    const timer = setTimeout(() => finish(false), 2000);
    child.on("message", onMessage);
    try {
      child.send(sessionHandoffMessage, (error) => { if (error) finish(false); });
    } catch {
      finish(false);
    }
  });
}
async function requestIpcShutdown(child: ChildProcess): Promise<boolean> {
  if (!child.connected || !child.send) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (sent: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sent);
    };
    const timer = setTimeout(() => finish(false), 1000);
    try {
      child.send(sessionShutdownMessage, (error) => { if (!error && child.connected) child.disconnect(); finish(!error); });
    } catch {
      finish(false);
    }
  });
}

function forceKillWorkerTree(child: ChildProcess, pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    if (!result.error && result.status === 0) return;
    if (child.exitCode !== null || child.signalCode !== null || !isProcessAlive(pid)) return;
    throw new Error(`taskkill no pudo cerrar el árbol del worker PID ${pid} (status=${result.status ?? "sin estado"}).`);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}
async function waitForWorkerTreeExit(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childExited = child.exitCode !== null || child.signalCode !== null;
    let groupExited = childExited;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, 0);
        groupExited = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        groupExited = true;
      }
    }
    if (childExited && groupExited) return true;
    await delay(100);
  }
  return false;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function removeOwnedRuntimeState(pid: number): Promise<void> {
  const current = await readCurrentSessionStateIfExists(currentPath).catch(() => undefined);
  if (current?.pid === pid) await fs.rm(currentPath, { force: true });
  const lock = await readJsonIfExists<{ pid?: number }>(lockPath).catch(() => undefined);
  if (lock?.pid === pid) await fs.rm(lockPath, { force: true });
}

async function sessionWorkerExitError(): Promise<Error> {
  const log = await fs.readFile(errPath, "utf8").then((value) => value.slice(-32_768)).catch(() => "");
  return startupErrorFromLog(log, "La sesión terminó antes de quedar lista. Revisá el log privado de la sesión en el runtime local.");
}
