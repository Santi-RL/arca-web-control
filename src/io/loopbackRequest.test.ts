import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  learningCommandTimeoutMs,
  loopbackHttpError,
  loopbackTimeoutMs,
  requestLoopbackJson,
  sessionCommandTimeoutMs,
} from "./loopbackRequest.js";

test("clasifica diagnósticos, preparación, emisión y finalización con plazos explícitos", () => {
  assert.equal(sessionCommandTimeoutMs({ type: "status" }), loopbackTimeoutMs.diagnostic);
  assert.equal(sessionCommandTimeoutMs({ type: "snapshot" }), loopbackTimeoutMs.diagnostic);
  assert.equal(sessionCommandTimeoutMs({ type: "prepare-invoice" }), loopbackTimeoutMs.prepare);
  assert.equal(sessionCommandTimeoutMs({ type: "emit-prepared-invoice" }), loopbackTimeoutMs.emission);
  assert.equal(sessionCommandTimeoutMs({ type: "revalidate-prepared-invoice" }), loopbackTimeoutMs.emission);
  assert.equal(sessionCommandTimeoutMs({ type: "open-service" }), loopbackTimeoutMs.mutation);
  assert.equal(learningCommandTimeoutMs({ type: "status" }), loopbackTimeoutMs.diagnostic);
  assert.equal(learningCommandTimeoutMs({ type: "finish" }), loopbackTimeoutMs.finish);
  assert.equal(learningCommandTimeoutMs({ type: "abort" }), loopbackTimeoutMs.stop);
  assert.equal(learningCommandTimeoutMs({ type: "click-exact" }), loopbackTimeoutMs.mutation);
  assert.ok(loopbackTimeoutMs.prepare > loopbackTimeoutMs.diagnostic);
  assert.ok(loopbackTimeoutMs.emission > loopbackTimeoutMs.diagnostic);
  assert.ok(loopbackTimeoutMs.finish > loopbackTimeoutMs.diagnostic);
});

test("vence también si fetch ignora AbortSignal y nunca reintenta una mutación", async () => {
  let attempts = 0;
  const stalledFetch = (() => {
    attempts += 1;
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;

  await assert.rejects(
    () => requestLoopbackJson("http://127.0.0.1:32123/command", {
      label: "la emisión preparada",
      timeoutMs: 10,
      mutation: true,
      init: { method: "POST", body: "{}" },
    }, stalledFetch),
    /resultado puede ser incierto.*no debe reintentarse automáticamente/i,
  );
  assert.equal(attempts, 1);
});

test("limita el destino a loopback y sanitiza errores HTTP antes de exponerlos", async () => {
  const privateToken = ["no", "debe", "salir"].join("-");
  await assert.rejects(
    () => requestLoopbackJson("https://example.invalid/command", {
      label: "el comando",
      timeoutMs: 10,
      mutation: false,
    }),
    /solo admite HTTP sobre 127\.0\.0\.1/i,
  );

  const response = await requestLoopbackJson("http://127.0.0.1:32123/command", {
    label: "el comando",
    timeoutMs: 100,
    mutation: false,
  }, (async () => new Response(JSON.stringify({
    message: "Falló C:\\Users\\persona\\privado\\job.json",
    token: privateToken,
  }), { status: 400 })) as typeof fetch);
  assert.equal(response.ok, false);
  assert.equal((response.payload as { token: string }).token, "[redacted]");
  const error = loopbackHttpError("el comando", response);
  assert.equal(error.message.includes(privateToken), false);
  assert.doesNotMatch(error.message, /persona/);
  assert.match(error.message, /\[ruta-privada\]/);
});

test("todos los clientes canónicos usan el helper acotado y MCP acota sus subprocesos", async () => {
  const files = [
    "scripts/arca-session-cmd.mts",
    "scripts/arca-session-stop.mts",
    "scripts/arca-mcp.mts",
    "scripts/arca-learn-cmd.mts",
  ];
  for (const file of files) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.match(source, /requestLoopbackJson/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }

  const mcp = await fs.readFile(path.resolve("scripts/arca-mcp.mts"), "utf8");
  assert.match(mcp, /runPrivateChildProcess\([\s\S]*?timeoutMs/);
  assert.match(mcp, /arca-session-start\.mts"[\s\S]*?210_000/);
  assert.match(mcp, /arca-invoice-prepare-chat\.mts"[\s\S]*?390_000/);
  assert.match(mcp, /arca-learn-start\.mts"[\s\S]*?315_000/);
});
