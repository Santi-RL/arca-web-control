import assert from "node:assert/strict";
import test from "node:test";
import { assertLearningCommandSafe, isHybridMutationAllowed, parseLearningCommandArgs } from "./commands.js";

const inspectionId = "00000000-0000-4000-8000-000000000001";

test("los comandos híbridos usan coincidencias exactas e índices explícitos", () => {
  assert.deepEqual(parseLearningCommandArgs(["inspect"]), { type: "inspect", pageIndex: undefined });
  assert.deepEqual(parseLearningCommandArgs(["inspect", "1"]), { type: "inspect", pageIndex: 1 });
  assert.deepEqual(parseLearningCommandArgs(["click-exact", inspectionId, "Continuar"]), { type: "click-exact", inspectionId, text: "Continuar" });
  assert.deepEqual(parseLearningCommandArgs(["select-exact", inspectionId, "1", "Factura C"]), { type: "select-exact", inspectionId, index: 1, option: "Factura C" });
  assert.deepEqual(parseLearningCommandArgs(["fill-input", inspectionId, "2"], "valor privado"), { type: "fill-input", inspectionId, index: 2, value: "valor privado" });
  assert.throws(() => parseLearningCommandArgs(["fill-input", inspectionId, "2", "valor-en-argv"], ""), /stdin/);
});

test("el modo aprendizaje bloquea acciones irreversibles y teclas de envío", () => {
  assert.throws(() => assertLearningCommandSafe(parseLearningCommandArgs(["click-exact", inspectionId, "Confirmar Datos..."])), /bloquea siempre/);
  assert.throws(() => assertLearningCommandSafe(parseLearningCommandArgs(["check-exact", inspectionId, "Confirmar presentación"])), /bloquea siempre/);
  assert.throws(() => assertLearningCommandSafe(parseLearningCommandArgs(["select-exact", inspectionId, "0", "Anular operación"])), /bloquea siempre/);
  assert.throws(() => assertLearningCommandSafe(parseLearningCommandArgs(["click-exact", inspectionId, "Confírmar Datos"])), /bloquea siempre/);
  assert.throws(() => parseLearningCommandArgs(["press", inspectionId, "Enter"]));
  assert.throws(() => parseLearningCommandArgs(["press", inspectionId, "ArrowDown"]));
});

test("las mutaciones híbridas solo operan en pantallas ARCA conocidas y previas al resumen", () => {
  assert.equal(isHybridMutationAllowed("https://portalcf.cloud.afip.gob.ar/portal/app/", "fill"), true);
  assert.equal(isHybridMutationAllowed("https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do", "check"), true);
  assert.equal(isHybridMutationAllowed("https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do", "click"), false);
  assert.equal(isHybridMutationAllowed("https://auth.afip.gob.ar/contribuyente_/login.xhtml", "fill"), false);
  assert.equal(isHybridMutationAllowed("https://example.invalid/rcel/jsp/genComDatosEmisor.do", "select"), false);
  assert.equal(isHybridMutationAllowed("https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/genComDatosEmisor.do", "select"), false);
  assert.equal(isHybridMutationAllowed("https://example.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do", "select"), false);
  assert.equal(isHybridMutationAllowed("https://fe.afip.gob.ar:8443/rcel/jsp/genComDatosEmisor.do", "select"), false);
  const atSign = String.fromCharCode(64);
  assert.equal(isHybridMutationAllowed(`https://user${atSign}fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do`, "select"), false);
});
