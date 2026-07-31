import assert from "node:assert/strict";
import test from "node:test";
import { recipientIdentityMatches } from "./controlEvidence.js";

test("acepta variantes de mayúsculas, tildes y puntuación con la misma forma societaria", () => {
  assert.equal(matches("SERVICIOS LOGÍSTICOS S.A.", "servicios logisticos SA"), true);
  assert.equal(matches("SERVICIOS, LOGISTICOS SA.", "Servicios Logísticos S.A."), true);
  assert.equal(matches("SERVICIOS-LOGISTICOS S.A.", "Servicios Logísticos SA"), true);
});

test("acepta un único error de un carácter en un token largo", () => {
  assert.equal(matches("SERVICOS LOGISTICOS SA", "SERVICIOS LOGISTICOS S.A."), true);
  assert.equal(matches("SERVCIOS LOGISTICOS SA", "SERVICIOS LOGISTICOS S.A."), true);
});

test("rechaza cualquier cambio de forma societaria o su omisión", () => {
  assert.equal(matches("SERVICIOS LOGISTICOS SRL", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS SAS", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS SAU", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS SA SRL", "SERVICIOS LOGISTICOS SA SRL"), false);
});

test("rechaza omisiones, agregados y reordenamientos de palabras comerciales", () => {
  assert.equal(matches("SERVICIOS SA", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS DEL SUR SA", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("LOGISTICOS SERVICIOS SA", "SERVICIOS LOGISTICOS S.A."), false);
});

test("rechaza dos errores tipográficos y diferencias en tokens cortos", () => {
  assert.equal(matches("SERVICOS LOGISTICO SA", "SERVICIOS LOGISTICOS S.A."), false);
  assert.equal(matches("SERVICIOS LOGISTICOS DEL SA", "SERVICIOS LOGISTICOS DE S.A."), false);
  assert.equal(matches("SERVICIOS 123457 SA", "SERVICIOS 123456 S.A."), false);
});

test("la tolerancia nominal nunca se aplica si el CUIT difiere o está malformado", () => {
  assert.equal(recipientIdentityMatches(
    { cuit: "20000000002", name: "SERVICIOS LOGISTICOS SA" },
    { cuit: "20000000001", name: "SERVICIOS LOGISTICOS S.A." },
  ), false);
  assert.equal(recipientIdentityMatches(
    { cuit: "20x00000000x1", name: "SERVICIOS LOGISTICOS SA" },
    { cuit: "20000000001", name: "SERVICIOS LOGISTICOS S.A." },
  ), false);
});

function matches(actualName: string, expectedName: string): boolean {
  return recipientIdentityMatches(
    { cuit: "20000000001", name: actualName },
    { cuit: "20-00000000-1", name: expectedName },
  );
}
