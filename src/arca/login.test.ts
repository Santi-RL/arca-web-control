import assert from "node:assert/strict";
import test from "node:test";
import { InvalidArcaCredentialsError, invalidCredentialsErrorFromLog, isInvalidArcaCredentialsMessage, startupErrorFromLog } from "./loginErrors.js";

test("reconoce el rechazo explícito de credenciales de ARCA", () => {
  assert.equal(isInvalidArcaCredentialsMessage("Clave o usuario incorrecto"), true);
  assert.equal(isInvalidArcaCredentialsMessage("  CLAVE   O USUARIO   INCORRECTO  "), true);
  assert.equal(isInvalidArcaCredentialsMessage("Ingresar con Clave Fiscal"), false);
});

test("el launcher traduce el marcador sin exponer datos ni sugerir reintento", () => {
  const error = startupErrorFromLog(`stack\n${new InvalidArcaCredentialsError().message}\n`, "fallback");
  assert.ok(error instanceof InvalidArcaCredentialsError);
  assert.match(error.message, /sin reintentar/);
  assert.doesNotMatch(error.message, /\d{11}/);
});

test("un log sin rechazo explícito no se interpreta como credencial inválida", () => {
  assert.equal(invalidCredentialsErrorFromLog("Timeout iniciando aprendizaje."), undefined);
});
