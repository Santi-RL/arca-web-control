import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireProcessLock } from "./processLock.js";

test("el lock global rechaza una segunda instancia viva y se libera", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-process-lock-"));
  const lockPath = path.join(directory, "global.lock");
  const release = await acquireProcessLock(lockPath, "sesión de prueba");
  await assert.rejects(() => acquireProcessLock(lockPath, "sesión de prueba"), /activa/);
  await release();
  const releaseAgain = await acquireProcessLock(lockPath, "sesión de prueba");
  await releaseAgain();
});

test("un lock huérfano bloquea hasta revisión manual", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-process-lock-"));
  const lockPath = path.join(directory, "global.lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, ownerToken: "stale" }));
  await assert.rejects(() => acquireProcessLock(lockPath, "sesión de prueba"), /huérfano/);
  assert.equal((await fs.stat(lockPath)).isFile(), true);
});

test("el lock conserva el identificador de lanzamiento sin alterar su ownership", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-process-lock-"));
  const lockPath = path.join(directory, "global.lock");
  const launchId = "00000000-0000-4000-8000-000000000001";
  const release = await acquireProcessLock(lockPath, "aprendizaje de prueba", { launchId });
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { launchId?: string; pid?: number; ownerToken?: string };
  assert.equal(lock.launchId, launchId);
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.ownerToken);
  await release();
  await assert.rejects(() => fs.stat(lockPath), /ENOENT/);
});
