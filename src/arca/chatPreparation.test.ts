import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { CurrentSessionState } from "./sessionState.js";
import { buildChatVisibleSessionStartArgs, parseChatPreparationArgs, sanitizePreparationOutput, sessionMetadataMatches, sessionStatusIsReusable } from "./chatPreparation.js";

const session = {
  issuerKey: "20000000001",
  visibilityMode: "visible",
  handoffComplete: true,
} as CurrentSessionState;

test("la ruta conversacional parsea solo flags cerrados", () => {
  assert.deepEqual(parseChatPreparationArgs([]), { revalidationCapability: undefined, timeoutMs: 180000 });
  assert.deepEqual(parseChatPreparationArgs(["--revalidate-irreversible", "invoice-services-single-item", "--timeout-ms", "90000"]), {
    revalidationCapability: "invoice-services-single-item",
    timeoutMs: 90000,
  });
  assert.throws(() => parseChatPreparationArgs(["--timeout-ms"]), /exige un valor/);
  assert.throws(() => parseChatPreparationArgs(["--otro"]), /no reconocido/);
});

test("la ruta conversacional autoriza el relevo controlado de una sesión anterior", () => {
  assert.deepEqual(buildChatVisibleSessionStartArgs({
    scriptPath: "arca-session-start.mts",
    issuerCuit: "20000000001",
    timeoutMs: 180000,
  }), [
    "--import",
    "tsx",
    "arca-session-start.mts",
    "--issuer",
    "20000000001",
    "--timeout-ms",
    "180000",
    "--force-new",
  ]);
  assert.deepEqual(buildChatVisibleSessionStartArgs({
    scriptPath: "arca-session-start.mts",
    issuerCuit: "27000000006",
    timeoutMs: 90000,
    revalidationCapability: "invoice-services-single-item",
  }).slice(-3), [
    "--force-new",
    "--revalidate-irreversible",
    "invoice-services-single-item",
  ]);
});

test("PowerShell reenvía el flag de revalidación cuando el separador de npm está citado", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "'{' | npm run arca:invoice:prepare-chat \"--\" --revalidate-irreversible invoice-services-single-item",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /La entrada privada no contiene un JSON válido\./);
  assert.doesNotMatch(output, /Argumento no reconocido|Unknown cli config/);
});

test("solo reutiliza una sesión visible, entregada y de la misma identidad y carril", () => {
  assert.equal(sessionMetadataMatches(session, "20000000001"), true);
  assert.equal(sessionMetadataMatches(session, "27000000006"), false);
  assert.equal(sessionMetadataMatches({ ...session, revalidationCapability: "invoice-services-single-item" }, "20000000001", "invoice-services-single-item"), true);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "portal", captchaVisible: false } }), true);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "service", captchaVisible: false } }), true);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "otro", captchaVisible: false } }), false);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "auth", captchaVisible: false } }), false);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "expired", captchaVisible: false } }), false);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "portal", captchaVisible: true } }), false);
  assert.equal(sessionStatusIsReusable({ state: { readyState: "portal", captchaVisible: false, revalidationConsumed: true } }), false);
});

test("la salida conversacional oculta rutas de captura pero conserva resumen e ID preparado", () => {
  const output = sanitizePreparationOutput({
    ok: true,
    status: "ok",
    data: {
      preparedInvoiceId: "00000000-0000-4000-8000-000000000000",
      screenshotPath: "C:\\privado\\captura.png",
      summary: { total: "100,00" },
    },
  });
  assert.equal(output.status, "prepared");
  assert.equal(JSON.stringify(output).includes("captura.png"), false);
  assert.equal(JSON.stringify(output).includes("preparedInvoiceId"), true);
});
