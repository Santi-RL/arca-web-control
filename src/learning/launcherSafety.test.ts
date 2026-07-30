import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildLearningWorkerArgs, isLearningShutdownMessage, learningShutdownMessage } from "./launcher.js";

test("el launcher no termina PIDs recuperados del estado ni elimina locks ajenos", async () => {
  const source = await fs.readFile(path.resolve("scripts", "arca-learn-start.mts"), "utf8");
  assert.doesNotMatch(source, /process\.kill\s*\(/);
  assert.doesNotMatch(source, /fs\.rm\s*\(\s*lockPath/);
  assert.match(source, /child\.kill\s*\(\)/);
  assert.match(source, /stdio:\s*\["ignore", out, err, "ipc"\]/);
  assert.deepEqual(buildLearningWorkerArgs("worker.mts", ["--issuer", "emisor"]), ["--import", "tsx", "worker.mts", "--issuer", "emisor"]);
  assert.equal(isLearningShutdownMessage(learningShutdownMessage), true);
  assert.equal(isLearningShutdownMessage({ type: "otro" }), false);
});

test("el worker instala el cierre controlado antes de abrir Chrome", async () => {
  const source = await fs.readFile(path.resolve("scripts", "arca-learn.mts"), "utf8");
  const signalHandler = source.indexOf('process.once("SIGTERM"');
  const browserLaunch = source.indexOf("context = await chromium.launchPersistentContext");
  assert.ok(signalHandler >= 0 && browserLaunch >= 0 && signalHandler < browserLaunch);
  assert.match(source, /process\.on\("message"/);
  assert.match(source, /context = await chromium\.launchPersistentContext[\s\S]*?assertStartupActive\(\)/);
  assert.match(source, /terminalAccepted = true[\s\S]*?if \(terminalAccepted \|\| error instanceof InvalidArcaCredentialsError\) requestStop\(\)/);
  assert.match(source, /loginToArca\([\s\S]*?manualIntervention:\s*false/);
  assert.doesNotMatch(source, /manualIntervention:\s*true/);
});

test("un captcha de login publica la pausa y conserva el worker visible", async () => {
  const worker = await fs.readFile(path.resolve("scripts", "arca-learn.mts"), "utf8");
  const serverListen = worker.indexOf('server?.listen(0, "127.0.0.1"');
  const login = worker.indexOf("await loginToArca(", serverListen);
  const captchaCatch = worker.indexOf("if (!isCaptchaRequiredError(error)) throw error", login);
  const publishPause = worker.indexOf('await publishState("captcha")', captchaCatch);
  const waitForExplicitCommand = worker.indexOf("await stopped", publishPause);
  assert.ok(serverListen >= 0 && login > serverListen && captchaCatch > login && publishPause > captchaCatch && waitForExplicitCommand > publishPause);
  assert.match(worker, /new AuthenticationAttemptGate\(\)/);
  assert.match(worker, /resumeLearningAuthentication\(/);
  assert.match(worker, /error instanceof InvalidArcaCredentialsError[\s\S]*?requestStop\(\)/);

  const launcher = await fs.readFile(path.resolve("scripts", "arca-learn-start.mts"), "utf8");
  assert.match(launcher, /child\.unref\(\)[\s\S]*?startupReadyState === "captcha"/);
  assert.match(launcher, /CAPTCHA_VISIBLE=true/);
  assert.match(launcher, /process\.exitCode = 2/);
});

test("las mutaciones de aprendizaje exigen el marcador y conservan status/abort para cierre", async () => {
  const source = await fs.readFile(path.resolve("scripts", "arca-learn-cmd.mts"), "utf8");
  assert.match(source, /commandArgs\[0\] !== "status" && commandArgs\[0\] !== "abort"/);
  const gate = source.indexOf("await useActiveSessionRuntimeLayout(runtime)");
  const endpoint = source.indexOf("buildLearningControlUrl(current)", gate);
  assert.ok(gate >= 0 && endpoint > gate);
});
