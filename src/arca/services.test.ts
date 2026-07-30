import assert from "node:assert/strict";
import test from "node:test";
import { knownSystemId, normalizeServiceName, serviceNameToRegExp } from "./services.js";

test("knownSystemId resolves Sistema de cuentas tributarias", () => {
  assert.equal(knownSystemId("Sistema de cuentas tributarias"), "cuenta_corriente_contrib");
  assert.equal(knownSystemId(" sistema   de cuentas tributarias "), "cuenta_corriente_contrib");
});

test("normalizeServiceName removes accents and repeated whitespace", () => {
  assert.equal(normalizeServiceName("  Comprobántes   en Línea "), "comprobantes en linea");
});

test("serviceNameToRegExp matches normalized service text", () => {
  const pattern = serviceNameToRegExp("Sistema de cuentas tributarias");
  assert.equal(pattern.test("Sistema de Cuentas Tributarias"), true);
});

test("serviceNameToRegExp matches accented portal text", () => {
  const pattern = serviceNameToRegExp("Comprobantes en Linea");
  assert.equal(pattern.test("Comprobantes en línea"), true);
});
