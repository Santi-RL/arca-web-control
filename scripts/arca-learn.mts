import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { loadCredentials, loadRuntimeConfig } from "../src/config/env.js";
import { ensureRuntimeLayout } from "../src/config/runtimePaths.js";
import { readJsonIfExists } from "../src/io/atomicJson.js";
import { loginToArca } from "../src/arca/login.js";
import { LearningRecorder } from "../src/learning/recorder.js";
import { acquireProcessLock } from "../src/io/processLock.js";
import { assertLearningCommandSafe, learningCommandSchema } from "../src/learning/commands.js";
import { isLearningShutdownMessage } from "../src/learning/launcher.js";
import { LearningTerminalGate } from "../src/learning/terminalGate.js";
import { publicLearningError } from "../src/learning/publicError.js";
import { writeCurrentLearningState } from "../src/learning/sessionState.js";

await run();

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const launchId = requireLaunchId(process.env.ARCA_LEARN_LAUNCH_ID);
  const runtime = await ensureRuntimeLayout();
  const currentPath = path.join(runtime.learning, "current.json");
  const releaseLock = await acquireProcessLock(path.join(runtime.learning, "current.lock"), "un aprendizaje ARCA", { launchId });
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let server: http.Server | undefined;
  let stopRequested = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  let cleanupPromise: Promise<void> | undefined;

  function requestStop(): void {
    if (stopRequested) return;
    stopRequested = true;
    void context?.close().catch(() => undefined);
    resolveStop();
  }

  function assertStartupActive(): void {
    if (stopRequested) throw new Error("El inicio del aprendizaje fue cancelado de forma controlada.");
  }

  async function shutdown(): Promise<void> {
    cleanupPromise ??= (async () => {
      await context?.close().catch(() => undefined);
      await closeServer(server);
      const current = await readJsonIfExists<{ launchId?: string; pid?: number }>(currentPath).catch(() => undefined);
      if (current?.launchId === launchId && current.pid === process.pid) await fs.rm(currentPath, { force: true }).catch(() => undefined);
      await releaseLock();
    })();
    await cleanupPromise;
  }

  process.on("message", (message) => { if (isLearningShutdownMessage(message)) requestStop(); });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    const config = loadRuntimeConfig();
    const credentials = loadCredentials(args.issuer);
    const directory = path.join(runtime.learning, `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.capability}`);
    const token = randomBytes(32).toString("hex");
    const profile = path.join(config.profileRoot, `learn_${credentials.issuerKey}`);
    assertStartupActive();
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: config.browserChannel, acceptDownloads: false, viewport: { width: 1440, height: 900 } });
    assertStartupActive();
    const page = context.pages()[0] ?? await context.newPage();
    await loginToArca(page, config, credentials, { strictSelectors: true, interactive: true, manualIntervention: true });
    assertStartupActive();
    const recorder = new LearningRecorder(page, directory);
    const terminalGate = new LearningTerminalGate();
    await recorder.start();
    server = http.createServer(async (request, response) => {
      let terminalAccepted = false;
      let commandType: string | undefined;
      try {
        if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { ok: false, message: "No autorizado." });
        if (request.method !== "POST") return send(response, 404, { ok: false });
        const command = learningCommandSchema.parse(JSON.parse(await readBody(request)));
        commandType = command.type;
        assertLearningCommandSafe(command);
        if (command.type === "finish" || command.type === "abort") {
          terminalGate.begin(command.type);
          terminalAccepted = true;
        }
        else terminalGate.assertOpen();
        if (command.type === "note") await recorder.note(command.text);
        if (command.type === "checkpoint") await recorder.note(`Checkpoint: ${command.name}`, command.name);
        if (command.type === "inspect") return send(response, 200, { ok: true, status: "learning", inspection: await recorder.inspect(command.pageIndex) });
        if (command.type === "click-exact") await recorder.clickExact(command.inspectionId, command.text);
        if (command.type === "select-exact") await recorder.selectExact(command.inspectionId, command.index, command.option);
        if (command.type === "fill-input") await recorder.fillInput(command.inspectionId, command.index, command.value);
        if (command.type === "check-exact") await recorder.checkExact(command.inspectionId, command.text);
        if (command.type === "press") await recorder.press(command.inspectionId, command.key);
        if (command.type === "finish") {
          const candidatePath = await recorder.finish({ capability: args.capability, intent: args.intent, issuerKey: credentials.issuerKey });
          send(response, 200, { ok: true, status: "candidate_generated", candidatePath });
          requestStop();
          return;
        }
        if (command.type === "abort") {
          await recorder.settle();
          send(response, 200, { ok: true, status: "aborted" });
          requestStop();
          return;
        }
        send(response, 200, { ok: true, status: "learning", eventCount: recorder.count, url: recorder.url, directory });
      } catch (error) {
        try {
          send(response, 400, { ok: false, message: publicLearningError(commandType, error) });
        } finally {
          if (terminalAccepted) requestStop();
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No se pudo iniciar el control de aprendizaje.");
    await writeCurrentLearningState(currentPath, { version: 1, launchId, pid: process.pid, host: "127.0.0.1", port: address.port, token, issuerKey: credentials.issuerKey, issuerName: credentials.displayName, capability: args.capability, intent: args.intent, directory });
    assertStartupActive();
    console.log("READY_STATE=learning");
    console.log(`LEARNING_DIR=${directory}`);
    await stopped;
    await shutdown();
  } catch (error) {
    await shutdown();
    if (stopRequested) return;
    throw error;
  }
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
}

function parseArgs(values: string[]): { issuer: string; capability: string; intent: string } {
  const get = (name: string) => { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined; };
  const issuer = get("--issuer"); const capability = get("--capability"); const intent = get("--intent");
  if (!issuer || !capability || !intent) throw new Error("Uso: --issuer <key> --capability <slug> --intent <objetivo>");
  if (!/^[a-z0-9-]+$/.test(capability)) throw new Error("capability debe usar minúsculas, números y guiones.");
  return { issuer, capability, intent };
}
function requireLaunchId(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Falta un identificador válido para iniciar el aprendizaje.");
  }
  return value;
}
async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("El comando de aprendizaje supera el tamaño permitido.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function send(response: http.ServerResponse, status: number, payload: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(payload)); }
