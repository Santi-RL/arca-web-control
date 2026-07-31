import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Browser, chromium, Page } from "playwright";
import { ResolvedInvoiceJob } from "../types.js";
import { captureRecipientEvidence } from "./controlEvidence.js";
import { ensureCommercialAddress } from "./invoice.js";
import { classifyCommercialAddressMatch } from "./recipientCommercialAddress.js";

const recipientUrl = "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do";

function invoiceJob(address: string): ResolvedInvoiceJob {
  return {
    schemaVersion: 2,
    operationId: "address-fixture-001",
    issuerKey: "20000000001",
    recipientCuit: "20000000001",
    recipientName: "RECEPTOR TOTALMENTE FICTICIO",
    recipientVatCondition: "Consumidor Final",
    recipientCommercialAddress: address,
    voucherType: "Factura C",
    pointOfSale: "00001",
    date: "2030-06-15",
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: "2030-06-01",
    billingPeriodTo: "2030-06-30",
    dueDate: "2030-06-20",
    saleCondition: "Transferencia Bancaria",
    description: "Servicio de prueba",
    amount: 123.45,
    amountCents: 12_345,
    amountDecimal: "123.45",
    outputDir: path.resolve("runtime-ficticio"),
  };
}

async function openFixture(browser: Browser, addressControls: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route(recipientUrl, (route) => route.fulfill({
    contentType: "text/html",
    body: `
      <label>Razón Social <input id="razonsocialreceptor" value="RECEPTOR TOTALMENTE FICTICIO"></label>
      <label>Condición frente al IVA
        <select id="idivareceptor"><option selected>Consumidor Final</option></select>
      </label>
      ${addressControls}
    `,
  }));
  await page.goto(recipientUrl);
  return page;
}

test("la equivalencia de domicilio solo contempla las denominaciones documentadas de CABA", () => {
  assert.equal(
    classifyCommercialAddressMatch(
      "Calle Ficticia 100 Piso:2 Dpto:A - Capital Federal, Ciudad de Buenos Aires",
      "Calle Ficticia 100 Piso 2 Dpto A, CABA",
    ),
    "caba-equivalent",
  );
  assert.equal(classifyCommercialAddressMatch("Calle Ficticia 100", "Calle Ficticia 1000"), "none");
});

test("selecciona el domicilio completo y no una coincidencia parcial", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser, `
      <label>Domicilio Comercial
        <select id="domicilioreceptorcombo" name="domicilioReceptorCombo">
          <option value="">seleccionar...</option>
          <option value="100">Avenida Ficticia 100</option>
          <option value="10">Avenida Ficticia 10</option>
          <option value="other">Otra</option>
        </select>
      </label>
    `);
    await ensureCommercialAddress(page, invoiceJob("Avenida Ficticia 10"), { strictSelectors: true, interactive: false, manualIntervention: false });
    assert.equal(await page.locator("#domicilioreceptorcombo").inputValue(), "10");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("detiene la selección cuando dos opciones equivalen al domicilio solicitado", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser, `
      <label>Domicilio Comercial
        <select id="domicilioreceptor" name="domicilioReceptor">
          <option value="">seleccionar...</option>
          <option value="a">Avenida Ficticia 100, CABA</option>
          <option value="b">Avenida Ficticia 100 - Capital Federal</option>
          <option value="other">Otra</option>
        </select>
      </label>
    `);
    await assert.rejects(
      () => ensureCommercialAddress(page, invoiceJob("Avenida Ficticia 100, CABA"), { strictSelectors: true, interactive: false, manualIntervention: false }),
      /coincide con más de una opción/i,
    );
    assert.equal(await page.locator("#domicilioreceptor").inputValue(), "");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("Otro/Otra exige y captura el domicilio personalizado en lugar del texto de la opción", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser, `
      <label>Domicilio Comercial
        <select id="domicilioreceptor" name="domicilioReceptor" onchange="document.querySelector('#domicilioOtro').hidden = this.value !== 'other'">
          <option value="">seleccionar...</option>
          <option value="known">Calle Ficticia 50</option>
          <option value="other">Otra</option>
        </select>
      </label>
      <label>Otro domicilio <input id="domicilioOtro" name="domicilioOtro" hidden></label>
    `);
    const job = invoiceJob("Pasaje Imaginario 321, CABA");
    await ensureCommercialAddress(page, job, { strictSelectors: true, interactive: false, manualIntervention: false });
    const evidence = await captureRecipientEvidence(page, job);
    assert.equal(evidence.recipientCommercialAddress, "Pasaje Imaginario 321, CABA");
    assert.notEqual(evidence.recipientCommercialAddress, "Otra");

    await page.locator("#domicilioOtro").fill("Domicilio Distinto 999");
    await assert.rejects(() => captureRecipientEvidence(page, job), /domicilio comercial visible no coincide con el job/i);
    await page.close();
  } finally {
    await browser.close();
  }
});
