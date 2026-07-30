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
  assert.match(source, /terminalAccepted = true[\s\S]*?if \(terminalAccepted\) requestStop\(\)/);
});
