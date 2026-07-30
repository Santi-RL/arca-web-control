import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { waitForRecipientAutofill } from "./invoice.js";

test("el autocompletado del receptor reconoce razón social y domicilio en un select sin agotar el timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRecipientFixture(page, `
      <input id="razonsocialreceptor" value="" />
      <select id="domicilioreceptor" name="domicilioReceptor">
        <option>seleccionar...</option>
      </select>
      <script>
        setTimeout(() => {
          document.querySelector('#razonsocialreceptor').value = 'RECEPTOR DE PRUEBA';
          document.querySelector('#domicilioreceptor').insertAdjacentHTML('beforeend', '<option>CALLE 123</option>');
        }, 50);
      </script>
    `);
    await waitForRecipientAutofill(page, 1000);
    assert.equal(await page.locator("#razonsocialreceptor").inputValue(), "RECEPTOR DE PRUEBA");
    assert.deepEqual(await page.locator("#domicilioreceptor option").allTextContents(), ["seleccionar...", "CALLE 123"]);
  } finally {
    await browser.close();
  }
});

test("el autocompletado del receptor falla si no aparece un domicilio verificable", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRecipientFixture(page, `
      <input id="razonsocialreceptor" value="RECEPTOR DE PRUEBA" />
      <select id="domicilioreceptor" name="domicilioReceptor"><option>seleccionar...</option></select>
    `);
    await assert.rejects(() => waitForRecipientAutofill(page, 150), /no completó razón social y domicilio/i);
  } finally {
    await browser.close();
  }
});

async function loadRecipientFixture(page: import("playwright").Page, body: string): Promise<void> {
  const url = "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do";
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
}
