import assert from "node:assert/strict";
import test from "node:test";
import { acquireLocalOsMutex } from "./osMutex.js";

test("el mutex local excluye concurrentes y vuelve a quedar disponible al liberar", async () => {
  const identity = `mutex-test-${process.pid}-${Date.now()}`;
  const release = await acquireLocalOsMutex(identity, "el recurso de prueba");
  await assert.rejects(() => acquireLocalOsMutex(identity, "el recurso de prueba"), /ya está en uso/);
  await release();
  const releaseAgain = await acquireLocalOsMutex(identity, "el recurso de prueba");
  await releaseAgain();
});

test("la espera opcional es acotada y no inicia la operación después del timeout", async () => {
  const identity = `mutex-timeout-test-${process.pid}-${Date.now()}`;
  const release = await acquireLocalOsMutex(identity, "el recurso de prueba");
  const startedAt = Date.now();
  await assert.rejects(
    () => acquireLocalOsMutex(identity, "el recurso de prueba", { timeoutMs: 40, retryDelayMs: 10 }),
    /tiempo límite.*no se inició/i,
  );
  assert.ok(Date.now() - startedAt >= 30);
  await release();
});

test("la espera opcional adquiere el mutex cuando el dueño lo libera", async () => {
  const identity = `mutex-wait-test-${process.pid}-${Date.now()}`;
  const release = await acquireLocalOsMutex(identity, "el recurso de prueba");
  const waiting = acquireLocalOsMutex(identity, "el recurso de prueba", { timeoutMs: 1_000, retryDelayMs: 10 });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await release();
  const releaseWaiting = await waiting;
  await releaseWaiting();
});
