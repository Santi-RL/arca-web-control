import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertPrivateImportPath, parseCredentialCsv, sourceDeletionRequired } from "./credentialImport.js";

test("el importador acepta nombres repetidos y conserva campos CSV entrecomillados", () => {
  const firstSecret = ["valor", "uno"].join("-");
  const secondSecret = ['valor, con "comillas"'].join("");
  const csv = [
    "Contribuyente,CUIT,Clave ARCA",
    `\"Contribuyente, Ficticio\",20-00000000-1,${firstSecret}`,
    `Contribuyente Ficticio,27-00000000-6,\"valor, con \"\"comillas\"\"\"`,
  ].join("\r\n");
  assert.deepEqual(parseCredentialCsv(Buffer.from(csv, "utf8")), [
    { displayName: "Contribuyente, Ficticio", cuit: "20000000001", clave: firstSecret },
    { displayName: "Contribuyente Ficticio", cuit: "27000000006", clave: secondSecret },
  ]);
});

test("el importador rechaza CUIT repetidos antes de escribir", () => {
  const hiddenValue = ["valor", "privado"].join("-");
  const csv = [
    "Contribuyente,CUIT,Clave ARCA",
    `Primero,20-00000000-1,${hiddenValue}`,
    `Segundo,20000000001,${hiddenValue}`,
  ].join("\n");
  assert.throws(() => parseCredentialCsv(Buffer.from(csv, "utf8")), /filas 2 y 3/);
});

test("los errores de sintaxis CSV no incluyen el valor sensible", () => {
  const hiddenValue = ["no", "mostrar", "esto"].join("-");
  const csv = `Contribuyente,CUIT,Clave ARCA\nPersona,20-00000000-1,\"${hiddenValue}`;
  assert.throws(() => parseCredentialCsv(Buffer.from(csv, "utf8")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(hiddenValue));
    return true;
  });
});

test("el importador rechaza CUIT contaminados y caracteres de control", () => {
  const value = ["valor", "prueba"].join("-");
  assert.throws(() => parseCredentialCsv(Buffer.from(`Contribuyente,CUIT,Clave ARCA\nPersona,CUIT 20-00000000-1,${value}`, "utf8")), /CUIT inválido/);
  assert.throws(() => parseCredentialCsv(Buffer.from(`Contribuyente,CUIT,Clave ARCA\n\"Persona\nOculta\",20-00000000-1,${value}`, "utf8")), /contribuyente inválido/);
});

test("el CSV debe permanecer dentro de private-import", () => {
  const root = path.resolve("C:\\privado\\private-import");
  assert.doesNotThrow(() => assertPrivateImportPath(path.join(root, "clientes.csv"), root));
  assert.throws(() => assertPrivateImportPath(path.resolve("C:\\publico\\clientes.csv"), root), /carpeta privada/);
  assert.throws(() => assertPrivateImportPath(path.join(root, "clientes.txt"), root), /extensión .csv/);
});

test("el CSV solo se marca para eliminar después de una escritura real", () => {
  assert.equal(sourceDeletionRequired(true), false);
  assert.equal(sourceDeletionRequired(false), true);
});
