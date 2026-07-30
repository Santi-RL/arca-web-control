import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadCredentialsAsync, loadRuntimeConfig } from "../src/config/env.js";
import type { ArcaLiveSession as ArcaLiveSessionInstance } from "../src/arca/liveSession.js";
import { isAuthorizedSessionRequest, sessionCommandSchema } from "../src/arca/sessionCommands.js";
import { requireHiddenCapability } from "../src/capabilities/registry.js";
import { SessionVisibilityMode } from "../src/types.js";
import { acquireProcessLock } from "../src/io/processLock.js";
import { isSessionHandoffMessage, isSessionShutdownMessage, notifySessionPublished, sessionHandoffAckMessage, sessionLauncherHandoffEnv } from "../src/arca/sessionLauncher.js";
import { measureArcaPerformance } from "../src/arca/performance.js";
import { sanitizeErrorMessage } from "../src/arca/publicErrors.js";
import { resolveSessionRuntime } from "../src/arca/sessionRuntime.js";
import { readCurrentSessionStateIfExists, writeCurrentSessionState } from "../src/arca/sessionState.js";

type Args = { issuer: string; visibilityMode: SessionVisibilityMode; learnedCapability?: string };
let shutdownRequested = false;
const launcherHandoffRequired = process.env[sessionLauncherHandoffEnv] === "1";
let launcherHandoffComplete = !launcherHandoffRequired;
let startupSettled = false;
let shutdownReady = false;
let lockReleased = false;
const startupAbort = new AbortController();
let shutdownPromise: Promise<void> | undefined;
let session: ArcaLiveSessionInstance | undefined;
let server: http.Server | undefined;
let releaseLock: (() => Promise<void>) | undefined;

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
process.on("message", (message) => {
  if (isSessionShutdownMessage(message)) {
    requestShutdown();
    return;
  }
  if (isSessionHandoffMessage(message)) {
    if (shutdownRequested) return;
    void completeLauncherHandoff();
  }
});
process.on("disconnect", () => { if (!launcherHandoffComplete) requestShutdown(); });
if (launcherHandoffRequired && !process.connected) requestShutdown();

const args = parseArgs(process.argv.slice(2));
const runtime = await measureArcaPerformance("worker_runtime", async () => await resolveSessionRuntime(launcherHandoffRequired, process, startupAbort.signal));
const config = loadRuntimeConfig();
const liveSessionModulePromise = measureArcaPerformance("worker_session_module", async () => await import("../src/arca/liveSession.js"));
const credentialsPromise = measureArcaPerformance("worker_credentials", async () => await loadCredentialsAsync(args.issuer));
const [{ ArcaLiveSession }, credentials] = await Promise.all([liveSessionModulePromise, credentialsPromise]);
const capability = args.visibilityMode === "production-hidden" ? await requireHiddenCapability(args.learnedCapability || "") : undefined;
const token = randomBytes(32).toString("hex");
const currentPath = path.join(runtime.sessions, "current.json");
const lockPath = path.join(runtime.sessions, "current.lock");
releaseLock = await acquireProcessLock(lockPath, "una sesión ARCA");
const startedAt = new Date().toISOString();
console.log("Iniciando sesión ARCA controlada...");
try {
  session = await ArcaLiveSession.create({
    issuerKey: credentials.issuerKey,
    config,
    credentials,
    visibilityMode: args.visibilityMode,
    learnedCapability: args.learnedCapability,
    allowedCommands: capability?.commands,
    startupSignal: startupAbort.signal,
  });
  startupSettled = true;
  if (shutdownRequested) {
    shutdownReady = true;
    await shutdown();
    process.exit(0);
  }

  server = http.createServer(async (request, response) => {
    try {
      const activeSession = session;
      if (!activeSession) return sendJson(response, 503, { ok: false, status: "not_ready" });
      if (!isAuthorizedSessionRequest(request.headers, token)) return sendJson(response, 401, { ok: false, status: "unauthorized" });
      if (request.method === "GET" && request.url === "/status") return sendJson(response, 200, { ok: true, status: "ok", state: await activeSession.getState() });
      if (request.method === "POST" && request.url === "/stop") {
        sendJson(response, 200, { ok: true, status: "stopping" });
        void shutdown();
        return;
      }
      if (request.method === "POST" && request.url === "/command") {
        const body = await readJsonBody(request);
        const command = sessionCommandSchema.parse((body as { command?: unknown }).command ?? body);
        const result = await activeSession.execute(command);
        await writeCurrent();
        return sendJson(response, result.ok ? 200 : result.status === "needs_manual_intervention" ? 409 : 400, result);
      }
      return sendJson(response, 404, { ok: false, status: "not_found" });
    } catch (error) {
      return sendJson(response, 400, { ok: false, status: "error", message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) });
    }
  });

  const listeningServer = server;
  const activeSession = session;
  await measureArcaPerformance("worker_publish_ready", async () => {
    await new Promise<void>((resolve) => listeningServer.listen(0, "127.0.0.1", resolve));
    await writeCurrent();
    if (launcherHandoffRequired) await notifySessionPublished(process, process.pid);
    shutdownReady = true;
    if (shutdownRequested) {
      await shutdown();
      process.exit(0);
    }
    const state = await activeSession.getState();
    console.log(`READY_URL=${state.url}`);
    console.log(`READY_STATE=${state.readyState}`);
    console.log(`SESSION_VISIBILITY=${state.visibilityMode}`);
    console.log(`SESSION_FILE=${currentPath}`);
  });
} catch (error) {
  startupSettled = true;
  shutdownReady = true;
  await shutdown();
  throw error;
}

async function writeCurrent(): Promise<void> {
  const activeServer = server;
  const activeSession = session;
  if (!activeServer || !activeSession) return;
  const address = activeServer.address();
  if (!address || typeof address === "string") return;
  await writeCurrentSessionState(currentPath, { version: 2, pid: process.pid, host: "127.0.0.1", port: address.port, token, issuerKey: credentials.issuerKey, issuerName: credentials.displayName, visibilityMode: args.visibilityMode, learnedCapability: args.learnedCapability, artifactDir: activeSession.artifactDir, startedAt, handoffComplete: launcherHandoffComplete, state: await activeSession.getState() });
}

async function completeLauncherHandoff(): Promise<void> {
  if (shutdownRequested || launcherHandoffComplete) return;
  launcherHandoffComplete = true;
  try {
    await writeCurrent();
    if (shutdownRequested) return;
    process.send?.(sessionHandoffAckMessage, () => undefined);
  } catch {
    launcherHandoffComplete = false;
    if (!process.connected) requestShutdown();
  }
}
function requestShutdown(): void {
  shutdownRequested = true;
  if (!startupSettled) startupAbort.abort();
  if (shutdownReady) void shutdown();
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<void> {
  await session?.close().catch(() => undefined);
  if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve())).catch(() => undefined);
  const current = await readCurrentSessionStateIfExists(currentPath).catch(() => undefined);
  if (current?.pid === process.pid) await fs.rm(currentPath, { force: true }).catch(() => undefined);
  if (!lockReleased && releaseLock) {
    lockReleased = true;
    await releaseLock();
  }
  if (process.connected) process.disconnect?.();
}

function parseArgs(values: string[]): Args {
  const get = (name: string) => { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined; };
  const issuer = get("--issuer"); if (!issuer) throw new Error("Uso: --issuer <issuerKey> [--production-hidden --capability <slug>]");
  const visibilityMode: SessionVisibilityMode = values.includes("--production-hidden") ? "production-hidden" : "visible";
  const learnedCapability = get("--capability");
  if (visibilityMode === "production-hidden" && !learnedCapability) throw new Error("--production-hidden requiere --capability.");
  return { issuer, visibilityMode, learnedCapability };
}
async function readJsonBody(request: http.IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 1024 * 1024) throw new Error("Cuerpo de comando demasiado grande."); chunks.push(buffer); } const raw = Buffer.concat(chunks).toString("utf8").trim(); return raw ? JSON.parse(raw) : {}; }
function sendJson(response: http.ServerResponse, code: number, payload: unknown): void { response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(payload, null, 2)); }
