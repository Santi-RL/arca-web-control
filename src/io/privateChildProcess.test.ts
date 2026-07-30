import assert from "node:assert/strict";
import test from "node:test";
import { runPrivateChildProcess } from "./privateChildProcess.js";

test("espera el drenaje completo de stdout antes de resolver", async () => {
  const expectedBytes = 192 * 1024;
  const result = await runPrivateChildProcess(process.execPath, [
    "-e",
    `process.stdout.write("x".repeat(${expectedBytes}))`,
  ]);
  assert.equal(Buffer.byteLength(result.stdout), expectedBytes);
});

test("rechaza fallos de arranque, códigos no cero y salidas fuera de límite", async () => {
  await assert.rejects(
    () => runPrivateChildProcess("comando-local-inexistente-para-prueba", []),
    /No se pudo iniciar/,
  );
  await assert.rejects(
    () => runPrivateChildProcess(process.execPath, ["-e", "process.stderr.write('fallo controlado'); process.exit(7)"]),
    /fallo controlado/,
  );
  await assert.rejects(
    () => runPrivateChildProcess(process.execPath, ["-e", "process.stderr.write('C:\\\\Users\\\\persona\\\\privado\\\\error.log'); process.exit(7)"]),
    (error: unknown) => error instanceof Error && !/persona/.test(error.message) && /\[ruta-privada\]/.test(error.message),
  );
  await assert.rejects(
    () => runPrivateChildProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxOutputBytes: 1024 }),
    /límite privado de salida/,
  );
});

test("puede conservar stdout estructurado para un código de intervención explícitamente admitido", async () => {
  const result = await runPrivateChildProcess(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({ok:false,status:'needs_manual_intervention',options:['A','B']})); process.stderr.write('diagnóstico privado'); process.exit(2)",
  ], { acceptedExitCodes: [0, 2] });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    status: "needs_manual_intervention",
    options: ["A", "B"],
  });
  assert.equal("stderr" in result, false);
});

test("vence y detiene un subproceso local sin reintentarlo", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => runPrivateChildProcess(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { timeoutMs: 25 }),
    /excedió el plazo.*no se reintentó/i,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});
