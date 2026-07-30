import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCredentialWriteInput, parseCredentialReference } from "./credentials.js";

test("la referencia de credencial usa el CUIT como identidad canónica", () => {
  assert.deepEqual(parseCredentialReference({
    issuerKey: "20000000001",
    displayName: "Contribuyente Ficticio",
    cuit: "20000000001",
    storageVersion: 2,
  }), {
    issuerKey: "20000000001",
    displayName: "Contribuyente Ficticio",
    cuit: "20000000001",
    storageVersion: 2,
  });
  assert.throws(() => parseCredentialReference({
    issuerKey: "CONTRIBUYENTE_FICTICIO",
    displayName: "Contribuyente Ficticio",
    cuit: "20000000001",
    storageVersion: 2,
  }), /identidad/);
});

test("el alta normaliza y valida el CUIT sin usar el nombre como clave", () => {
  const testValue = ["valor", "prueba"].join("-");
  const first = normalizeCredentialWriteInput({
    issuerKey: "Contribuyente Ficticio",
    cuit: "20-00000000-1",
    clave: testValue,
  });
  assert.deepEqual(first, {
    issuerKey: "20000000001",
    displayName: "Contribuyente Ficticio",
    cuit: "20000000001",
    clave: testValue,
  });
  const sameCuitDifferentName = normalizeCredentialWriteInput({
    issuerKey: "Otra persona con el mismo nombre no importa",
    displayName: "Otro nombre",
    cuit: "20000000001",
    clave: ["otro", "valor", "prueba"].join("-"),
  });
  assert.equal(sameCuitDifferentName.issuerKey, first.issuerKey);
  assert.notEqual(sameCuitDifferentName.displayName, first.displayName);
  assert.throws(() => normalizeCredentialWriteInput({ issuerKey: "Contribuyente Ficticio", cuit: "20000000002", clave: "x" }), /CUIT inválido/);
});
