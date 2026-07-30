import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { waitForCalculatedInvoiceTotal } from "./invoice.js";

test("el cálculo del total espera el valor derivado en vez de dormir un tiempo fijo", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const fixture = `
      <input id="detalle_precio1" value="123456.78">
      <input id="importe_ajeno" readonly value="123.456,78">
      <table>
        <tr><td>Subtotal: $</td><td><input id="subtotal" readonly value=""></td></tr>
        <tr><td>Importe Total: $</td><td><input id="importe_total" readonly value=""></td></tr>
      </table>
      <script>setTimeout(() => {
        document.querySelector('#subtotal').value = '123456.78';
        document.querySelector('#importe_total').value = '123.456,78';
      }, 40)</script>
    `;
    const url = "https://fe.afip.gob.ar/rcel/jsp/genComDatosOperacion.do";
    await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto(url);
    const observedWaitDurations: number[] = [];
    const originalWaitForTimeout = page.waitForTimeout.bind(page);
    page.waitForTimeout = async (timeout) => {
      observedWaitDurations.push(timeout);
      await originalWaitForTimeout(timeout);
    };
    await waitForCalculatedInvoiceTotal(page, 12_345_678, 1000);

    await page.locator("#subtotal, #importe_total").evaluateAll((inputs) => {
      for (const input of inputs) (input as HTMLInputElement).value = "1.00";
    });
    await assert.rejects(
      () => waitForCalculatedInvoiceTotal(page, 12_345_678, 100),
      /no mostró el subtotal y el importe total calculados/i,
    );
    assert.equal(observedWaitDurations.every((duration) => duration <= 50), true);
  } finally {
    await browser.close();
  }
});
