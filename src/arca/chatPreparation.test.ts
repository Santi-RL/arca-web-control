import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentSessionState } from "./sessionState.js";
import { parseChatPreparationArgs, sanitizePreparationOutput, sessionMetadataMatches, sessionStatusIsReusable } from "./chatPreparation.js";

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
