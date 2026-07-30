import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeErrorMessage } from "./publicErrors.js";

test("los errores públicos no reflejan secretos de URLs, cookies ni rutas de perfil", () => {
  const atSign = String.fromCharCode(64);
  const message = [
    `goto https://usuario:secreto${atSign}fe.afip.gob.ar/rcel;jsessionid=TOKEN/jsp/menu.do?token=reservado#fragmento`,
    "data:text/plain,dato-reservado",
    "C:\\Users\\PersonaPrivada\\Downloads\\factura.pdf",
    "  - cookie: session=valor-reservado",
  ].join("\n");
  const safe = sanitizeErrorMessage(message);
  for (const secret of ["usuario", "secreto", "TOKEN", "reservado", "dato-reservado", "PersonaPrivada", "session=valor-reservado"]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.equal(safe.includes("https://fe.afip.gob.ar/rcel/jsp/menu.do"), true);
  assert.equal(safe.includes("[url-no-confiable]"), true);
  assert.equal(safe.includes("[ruta-privada]/"), true);
  assert.equal(safe.includes("cookie: [redacted]"), true);
});
