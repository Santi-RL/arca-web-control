import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { candidate, classifyArcaAccessFailure, selectOptionContaining, waitForAnyVisible } from "./pageHelpers.js";

test("clasifica sesión expirada y 403 sin sugerir reintentos", () => {
  assert.equal(classifyArcaAccessFailure("https://portalcf.cloud.afip.gob.ar/portal/app/expiredSession", "Portal", "TU SESIÓN HA EXPIRADO"), "expired");
  assert.equal(classifyArcaAccessFailure("https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do", "403 Forbidden", "Forbidden\nYou don't have permission to access this server."), "forbidden");
  assert.equal(classifyArcaAccessFailure("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp", "RCEL", "Generar Comprobantes"), undefined);
});

test("espera una señal visible real y conserva la selección exacta y única", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <select id="tipo">
        <option value="">seleccionar...</option>
        <option value="fc">Factura C</option>
      </select>
      <div id="resultado" hidden>Comprobantes en línea</div>
      <script>setTimeout(() => { document.querySelector('#resultado').hidden = false; }, 40)</script>
    `);
    await waitForAnyVisible([candidate(page.locator("#resultado"), "resultado")], "resultado demorado", 1000);
    await selectOptionContaining(page.locator("#tipo"), "Factura C");
    assert.equal(await page.locator("#tipo").inputValue(), "fc");

    await page.locator("#tipo").evaluate((select) => select.insertAdjacentHTML("beforeend", '<option value="fc2">Factura C</option>'));
    await assert.rejects(() => selectOptionContaining(page.locator("#tipo"), "Factura C"), /exacta y única/i);
  } finally {
    await browser.close();
  }
});
