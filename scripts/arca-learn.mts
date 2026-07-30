import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { loadCredentials, loadRuntimeConfig } from "../src/config/env.js";
import { ensureRuntimeLayout } from "../src/config/runtimePaths.js";
import { readJsonIfExists } from "../src/io/atomicJson.js";
import { continueArcaAccessIfRequested, loginToArca } from "../src/arca/login.js";
import { isCaptchaVisible } from "../src/arca/captcha.js";
import { CaptchaRequiredError, isCaptchaRequiredError } from "../src/arca/captchaErrors.js";
import { AuthenticationAttemptGate } from "../src/arca/authenticationAttemptGate.js";
import { InvalidArcaCredentialsError } from "../src/arca/loginErrors.js";
import { isOfficialArcaPortalUrl } from "../src/arca/officialUrls.js";
import { SessionCommandGate } from "../src/arca/sessionCommandGate.js";
import { LearningRecorder } from "../src/learning/recorder.js";
import { acquireProcessLock } from "../src/io/processLock.js";
import { assertLearningCommandSafe, learningCommandSchema } from "../src/learning/commands.js";
import { isLearningShutdownMessage } from "../src/learning/launcher.js";
import { LearningTerminalGate } from "../src/learning/terminalGate.js";
import { publicLearningError } from "../src/learning/publicError.js";
import { writeCurrentLearningState } from "../src/learning/sessionState.js";
import { resumeLearningAuthentication } from "../src/learning/authentication.js";

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
    const authenticationAttempts = new AuthenticationAttemptGate();
    const commandGate = new SessionCommandGate();
    const terminalGate = new LearningTerminalGate();
    let recorder: LearningRecorder | undefined;
    let readyState: "captcha" | "learning" | undefined;
    let controlPort = 0;

    const publishState = async (nextState: "captcha" | "learning"): Promise<void> => {
      if (!controlPort) throw new Error("El control local de aprendizaje todavía no está listo.");
      readyState = nextState;
      await writeCurrentLearningState(currentPath, {
        version: 1,
        launchId,
        pid: process.pid,
        host: "127.0.0.1",
        port: controlPort,
        token,
        issuerKey: credentials.issuerKey,
        issuerName: credentials.displayName,
        capability: args.capability,
        intent: args.intent,
        directory,
        readyState: nextState,
      });
    };

    const activateRecorder = async (): Promise<LearningRecorder> => {
      if (!isOfficialArcaPortalUrl(page.url())) {
        throw new Error("ARCA no confirmó el Portal de Clave Fiscal. El registrador no se habilitó.");
      }
      if (!recorder) {
        const candidate = new LearningRecorder(page, directory);
        await candidate.start();
        recorder = candidate;
      }
      authenticationAttempts.markResumed();
      await publishState("learning");
      return recorder;
    };

    const sendCaptchaPause = async (response: http.ServerResponse): Promise<void> => {
      authenticationAttempts.markCaptchaRequired();
      await page.bringToFront().catch(() => undefined);
      await publishState("captcha");
      send(response, 200, {
        ok: false,
        status: "needs_manual_intervention",
        code: new CaptchaRequiredError().code,
        message: new CaptchaRequiredError().message,
        readyState: "captcha",
        captchaVisible: await isCaptchaVisible(page).catch(() => false),
      });
    };

    server = http.createServer(async (request, response) => {
      let terminalAccepted = false;
      let commandType: string | undefined;
      let releaseCommand: (() => void) | undefined;
      try {
        if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { ok: false, message: "No autorizado." });
        if (request.method !== "POST" || request.url !== "/") return send(response, 404, { ok: false });
        const command = learningCommandSchema.parse(JSON.parse(await readBody(request)));
        commandType = command.type;
        assertLearningCommandSafe(command);

        releaseCommand = commandGate.tryAcquire();
        if (!releaseCommand) return send(response, 409, { ok: false, status: "busy", message: "El aprendizaje ya está procesando otro comando." });

        if (command.type === "status") {
          return send(response, 200, {
            ok: true,
            status: readyState ?? "starting",
            readyState: readyState ?? "starting",
            captchaVisible: readyState === "captcha" ? await isCaptchaVisible(page).catch(() => false) : false,
            eventCount: recorder?.count ?? 0,
          });
        }

        if (command.type === "abort") {
          terminalGate.begin(command.type);
          terminalAccepted = true;
        }
        else terminalGate.assertOpen();

        if (command.type === "abort") {
          await recorder?.settle();
          send(response, 200, { ok: true, status: "aborted" });
          requestStop();
          return;
        }

        if (command.type === "resume-authentication") {
          const outcome = await resumeLearningAuthentication({
            gate: authenticationAttempts,
            isCaptchaVisible: async () => await isCaptchaVisible(page),
            currentUrl: () => page.url(),
            continueAccess: async () => await continueArcaAccessIfRequested(page, credentials, {
              strictSelectors: true,
              interactive: true,
              manualIntervention: false,
            }),
          });
          if (outcome === "captcha") return await sendCaptchaPause(response);
          if (outcome === "unexpected") {
            return send(response, 200, {
              ok: false,
              status: "needs_manual_intervention",
              message: "La pantalla visible no es el login oficial ni el Portal de Clave Fiscal esperado. No se reenvió ningún formulario.",
              readyState: "captcha",
            });
          }
          const activeRecorder = await activateRecorder();
          return send(response, 200, { ok: true, status: "learning", readyState: "learning", eventCount: activeRecorder.count });
        }

        if (await isCaptchaVisible(page)) return await sendCaptchaPause(response);
        authenticationAttempts.assertMutationAllowed();
        const activeRecorder = recorder;
        if (!activeRecorder || readyState !== "learning") {
          throw new Error("El aprendizaje sigue pausado antes del login. Solo se admite status, resume-authentication o abort.");
        }

        if (command.type === "finish") {
          terminalGate.begin(command.type);
          terminalAccepted = true;
        }
        if (command.type === "note") await activeRecorder.note(command.text);
        if (command.type === "checkpoint") await activeRecorder.note(`Checkpoint: ${command.name}`, command.name);
        if (command.type === "inspect") return send(response, 200, { ok: true, status: "learning", inspection: await activeRecorder.inspect(command.pageIndex) });
        if (command.type === "click-exact") await activeRecorder.clickExact(command.inspectionId, command.text);
        if (command.type === "select-exact") await activeRecorder.selectExact(command.inspectionId, command.index, command.option);
        if (command.type === "fill-input") await activeRecorder.fillInput(command.inspectionId, command.index, command.value);
        if (command.type === "check-exact") await activeRecorder.checkExact(command.inspectionId, command.text);
        if (command.type === "press") await activeRecorder.press(command.inspectionId, command.key);
        if (command.type === "finish") {
          const candidatePath = await activeRecorder.finish({ capability: args.capability, intent: args.intent, issuerKey: credentials.issuerKey });
          send(response, 200, { ok: true, status: "candidate_generated", candidatePath });
          requestStop();
          return;
        }
        send(response, 200, { ok: true, status: "learning", eventCount: activeRecorder.count, url: activeRecorder.url, directory });
      } catch (error) {
        try {
          send(response, 400, { ok: false, message: publicLearningError(commandType, error) });
        } finally {
          if (terminalAccepted || error instanceof InvalidArcaCredentialsError) requestStop();
        }
      } finally {
        releaseCommand?.();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No se pudo iniciar el control de aprendizaje.");
    controlPort = address.port;

    // El launcher desacopla este worker con stdin=ignore. El control HTTP ya
    // está disponible cuando el login detecta un captcha, de modo que Chrome
    // puede permanecer visible sin readline ni reintentos automáticos.
    try {
      await loginToArca(page, config, credentials, { strictSelectors: true, interactive: true, manualIntervention: false });
    } catch (error) {
      if (error instanceof InvalidArcaCredentialsError) authenticationAttempts.markRejected();
      if (!isCaptchaRequiredError(error)) throw error;
      authenticationAttempts.markCaptchaRequired();
      await page.bringToFront().catch(() => undefined);
      await publishState("captcha");
      assertStartupActive();
      console.log("READY_STATE=captcha");
      console.log(`LEARNING_DIR=${directory}`);
      await stopped;
      await shutdown();
      return;
    }

    assertStartupActive();
    await activateRecorder();
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
