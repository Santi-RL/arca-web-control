import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { initialVoucherTypeSelector, selectActivityIfNeeded } from "./invoice.js";
import { ResolvedInvoiceJob } from "../types.js";
import { captureCurrencyEvidence } from "./controlEvidence.js";

test("la pantalla real de punto de venta identifica universoComprobante de forma única", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas", `
      <select id="puntodeventa" name="puntoDeVenta"><option>00001-Domicilio</option></select>
      <select id="universocomprobante" name="universoComprobante"><option>Factura C</option></select>
    `);
    const voucherType = page.locator(initialVoucherTypeSelector);
    assert.equal(await voucherType.count(), 1);
    assert.equal(await voucherType.locator("option").textContent(), "Factura C");
  } finally {
    await browser.close();
  }
});

test("una actividad omitida debe permanecer en la opción vacía", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do", `
      <select id="actividad" name="actividad">
        <option value="-1">seleccionar...</option>
        <option value="620100">620100 - SERVICIOS</option>
      </select>
    `);
    await selectActivityIfNeeded(page, { activity: undefined } as ResolvedInvoiceJob);
    await page.locator("#actividad option").first().evaluate((option) => { (option as HTMLOptionElement).value = "620100"; });
    await assert.rejects(() => selectActivityIfNeeded(page, { activity: undefined } as ResolvedInvoiceJob), /preseleccionada/);
    await page.locator("#actividad option").first().evaluate((option) => { option.removeAttribute("value"); });
    await assert.rejects(() => selectActivityIfNeeded(page, { activity: undefined } as ResolvedInvoiceJob), /preseleccionada/);
    await page.locator("#actividad option").first().evaluate((option) => { (option as HTMLOptionElement).value = "-1"; });
    await page.locator("#actividad").selectOption("620100");
    await assert.rejects(() => selectActivityIfNeeded(page, { activity: undefined } as ResolvedInvoiceJob), /preseleccionada/);
  } finally {
    await browser.close();
  }
});

test("la moneda ARS exige un único checkbox Moneda Extranjera visible y desmarcado", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const job = { currency: "ARS" } as ResolvedInvoiceJob;
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do", `
      <label><input type="checkbox" name="monedaExtranjera"> Moneda Extranjera</label>
    `);
    assert.deepEqual(await captureCurrencyEvidence(page, job), { currency: "ARS" });

    await page.setContent(`<label><input type="checkbox" name="monedaExtranjera" checked> Moneda Extranjera</label>`);
    await assert.rejects(() => captureCurrencyEvidence(page, job), /Moneda Extranjera marcada.*bloqueada/i);

    await page.setContent(`<p>El control de moneda no está disponible.</p>`);
    await assert.rejects(() => captureCurrencyEvidence(page, job), /único control visible.*0/i);

    await page.setContent(`
      <label><input type="checkbox"> Moneda Extranjera</label>
      <label><input type="checkbox"> Moneda Extranjera</label>
    `);
    await assert.rejects(() => captureCurrencyEvidence(page, job), /único control visible.*2/i);
  } finally {
    await browser.close();
  }
});

async function loadRcelFixture(page: import("playwright").Page, url: string, body: string): Promise<void> {
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
}
