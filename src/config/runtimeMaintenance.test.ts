import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { getRuntimePathsForTesting } from "./runtimePaths.js";
import { acquireRuntimeMaintenanceTransition, assertNoLiveRuntimeActivity } from "./runtimeMaintenance.js";

test("la reparación se bloquea ante una sesión o aprendizaje vivo y admite estados de procesos terminados", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-maintenance-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.sessions, { recursive: true });
  await fs.mkdir(runtime.learning, { recursive: true });
  await fs.writeFile(path.join(runtime.sessions, "current.json"), JSON.stringify({ pid: 41001 }));

  await assert.rejects(() => assertNoLiveRuntimeActivity(runtime, (pid) => pid === 41001), /sesión ARCA activa/);
  await assertNoLiveRuntimeActivity(runtime, () => false);

  await fs.writeFile(path.join(runtime.learning, "current.lock"), JSON.stringify({ pid: 41002 }));
  await assert.rejects(() => assertNoLiveRuntimeActivity(runtime, (pid) => pid === 41002), /aprendizaje ARCA activa/);
});

test("un indicador manipulado bloquea la reparación sin seguir enlaces", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-maintenance-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.sessions, { recursive: true });
  await fs.writeFile(path.join(runtime.sessions, "current.lock"), "no-json");
  await assert.rejects(() => assertNoLiveRuntimeActivity(runtime, () => false), /bloquea por seguridad/);
});

test("el comando comprueba actividad antes de iniciar la reparación recursiva", async () => {
  const source = await fs.readFile(path.resolve("scripts", "arca-runtime-repair.mts"), "utf8");
  const activityCheck = source.indexOf("await assertNoLiveRuntimeActivity(runtime)");
  const repair = source.indexOf("await repairManagedRuntimeAcl(runtime)");
  assert.ok(activityCheck >= 0 && repair > activityCheck);
});

test("mantenimiento y arranque comparten una transición exclusiva liberable", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-transition-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const release = await acquireRuntimeMaintenanceTransition(runtime);
  await assert.rejects(
    () => acquireRuntimeMaintenanceTransition(runtime),
    /transición.*en uso/i,
  );
  await release();

  const releaseAgain = await acquireRuntimeMaintenanceTransition(runtime);
  await releaseAgain();
});
