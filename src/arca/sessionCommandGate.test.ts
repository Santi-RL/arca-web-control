import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SessionCommandGate } from "./sessionCommandGate.js";

test("la sesión admite una sola solicitud Playwright por vez", () => {
  const gate = new SessionCommandGate();
  const releaseFirst = gate.tryAcquire();
  assert.ok(releaseFirst);
  assert.equal(gate.tryAcquire(), undefined);

  releaseFirst();
  const releaseSecond = gate.tryAcquire();
  assert.ok(releaseSecond);
  releaseSecond();
});

test("liberar dos veces una reserva no abre concurrencia adicional", () => {
  const gate = new SessionCommandGate();
  const release = gate.tryAcquire();
  assert.ok(release);
  release();
  release();

  const next = gate.tryAcquire();
  assert.ok(next);
  assert.equal(gate.tryAcquire(), undefined);
  next();
});

test("el endpoint stop también respeta el gate mientras hay un comando fiscal", async () => {
  const source = await fs.readFile(path.resolve("scripts", "arca-session.mts"), "utf8");
  const stopStart = source.indexOf('request.url === "/stop"');
  const commandStart = source.indexOf('request.url === "/command"');
  const stopBlock = source.slice(stopStart, commandStart);
  assert.ok(stopStart >= 0 && commandStart > stopStart);
  assert.match(stopBlock, /commandGate\.tryAcquire\(\)/u);
  assert.match(stopBlock, /409/u);
  assert.match(stopBlock, /shutdown\(\)\.finally/u);
});
