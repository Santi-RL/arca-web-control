import assert from "node:assert/strict";
import test from "node:test";
import { mapWindowsCredentialReadError, normalizeCredentialWriteInput, parseCredentialReference } from "./credentials.js";

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

test("el timeout real de execFile en Windows no se confunde con una credencial inexistente", () => {
  const timeout = Object.assign(new Error("Command failed"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
    stderr: "",
  });

  const mapped = mapWindowsCredentialReadError(timeout, "20000000001");

  assert.match(mapped.message, /no respondió dentro del plazo seguro/i);
  assert.doesNotMatch(mapped.message, /no existe una credencial/i);
});

test("un fallo al iniciar el proveedor no se confunde con una credencial inexistente", () => {
  const unavailable = Object.assign(new Error("spawn powershell ENOENT"), {
    code: "ENOENT",
    killed: false,
    stderr: "",
  });

  const mapped = mapWindowsCredentialReadError(unavailable, "20000000001");

  assert.match(mapped.message, /no se pudo ejecutar el proveedor/i);
  assert.doesNotMatch(mapped.message, /no existe una credencial/i);
});
