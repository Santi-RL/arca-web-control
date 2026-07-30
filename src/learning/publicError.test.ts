import assert from "node:assert/strict";
import test from "node:test";
import { publicLearningError } from "./publicError.js";

test("los errores de fill-input nunca devuelven el valor privado", () => {
  const value = "VALOR-PRIVADO-QUE-NO-DEBE-SALIR";
  const message = publicLearningError("fill-input", new Error(`locator.fill('${value}') falló`));
  assert.doesNotMatch(message, new RegExp(value));
  assert.match(message, /redactado/);
});

test("los demás errores sanitizan queries y rutas privadas", () => {
  const message = publicLearningError(
    "status",
    new Error("falló https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp?token=VALOR-PRIVADO en C:\\Users\\PersonaPrivada\\ManejoARCA\\current.json"),
  );

  assert.equal(message.includes("VALOR-PRIVADO"), false);
  assert.equal(message.includes("PersonaPrivada"), false);
  assert.match(message, /https:\/\/fe\.afip\.gob\.ar\/rcel\/jsp\/menu_ppal\.jsp/);
  assert.match(message, /\[ruta-privada\]\//);
});
