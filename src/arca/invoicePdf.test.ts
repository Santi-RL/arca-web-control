import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { chromium } from "playwright";
import { reservePrivatePdfDestination } from "../config/privateDownloads.js";
import { assertArcaInvoicePdfMatchesKnownReceipt, buildArcaInvoicePdfExpectation, downloadGeneratedInvoicePdf, inspectArcaInvoicePdf, persistGeneratedInvoiceDownload } from "./invoicePdf.js";

const expectedFiscalRows = {
  billingPeriodFrom: "01/06/2030",
  billingPeriodTo: "30/06/2030",
  dueDate: "20/06/2030",
  saleCondition: "Transferencia Bancaria",
};

const validFiscalRowsHtml = `
  <p>Período Facturado Desde: 01/06/2030 Hasta: 30/06/2030</p>
  <p>Fecha de Vto. para el pago: 20/06/2030</p>
  <p>Condición de venta: Transferencia Bancaria</p>
`;

const sameCuitIdentifiedRecipientHtml = `<p><span>CUIT: 20-00000000-1</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social: RECEPTOR FICTICIO</span></p>`;
const anonymousRecipientRowsHtml = `
  <p>Doc.: - Apellido y Nombre / Razón Social:</p>
  <p><span>Condición frente al IVA: Consumidor Final</span><span style="margin-left: 180px">Domicilio:</span></p>
`;

test("captura la descarga directa iniciada por Imprimir y la publica sin depender de una URL HTML", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-direct-pdf-");
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await loadGeneratedInvoiceFixture(page, `<a download="comprobante.pdf" href="data:application/pdf;base64,JVBERi0xLjQK">Imprimir...</a>`);
    const destination = path.join(directory, "comprobante.pdf");
    const reservation = await reservePrivatePdfDestination(destination, directory, directory);
    try {
      assert.equal(await downloadGeneratedInvoicePdf(page, reservation, 1000), destination);
      assert.equal((await fs.readFile(destination)).subarray(0, 5).toString("ascii"), "%PDF-");
    } finally {
      await reservation.release();
    }
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Imprimir se acciona una sola vez cuando el navegador no entrega la descarga", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-missing-pdf-");
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await loadGeneratedInvoiceFixture(page, `<button onclick="window.clicks=(window.clicks||0)+1">Imprimir...</button>`);
    const reservation = await reservePrivatePdfDestination(path.join(directory, "comprobante.pdf"), directory, directory);
    try {
      await assert.rejects(() => downloadGeneratedInvoicePdf(page, reservation, 1000), /No se reintentó el clic/i);
      assert.equal(await page.evaluate(() => (window as typeof window & { clicks?: number }).clicks), 1);
    } finally {
      await reservation.release();
    }
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sin un único Imprimir visible se detiene sin abrir una URL alternativa", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-no-print-control-");
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await loadGeneratedInvoiceFixture(page, `<p>Comprobante Generado</p><script>window.openCalls=0;window.open=()=>{window.openCalls+=1;return null;}</script>`);
    const reservation = await reservePrivatePdfDestination(path.join(directory, "comprobante.pdf"), directory, directory);
    try {
      await assert.rejects(() => downloadGeneratedInvoicePdf(page, reservation, 1000), /único control visible.*URL alternativa/i);
      assert.equal(await page.evaluate(() => (window as typeof window & { openCalls: number }).openCalls), 0);
    } finally {
      await reservation.release();
    }
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("un navegador que no concluye failure queda acotado, preserva el temporal y cancela sin reintento", async () => {
  let preserved = 0;
  let cancelled = 0;
  const never = new Promise<null>(() => undefined);
  await assert.rejects(
    () => persistGeneratedInvoiceDownload({
      failure: () => never,
      saveAs: async () => undefined,
      cancel: async () => { cancelled += 1; },
    }, {
      path: path.resolve("destino-ficticio.pdf"),
      temporaryPath: path.resolve("temporal-ficticio.pdf"),
      release: async () => undefined,
      preserveTemporary: () => { preserved += 1; },
    }, Date.now() + 25),
    /plazo seguro.*no se reintentó el clic/i,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preserved, 1);
  assert.equal(cancelled, 1);
});

async function loadGeneratedInvoiceFixture(page: import("playwright").Page, body: string): Promise<void> {
  const url = "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do";
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
}

test("valida el PDF fiscal y extrae número de comprobante y CAE", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-inspect-pdf-");
  const pdfPath = path.join(directory, "factura.pdf");
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <p>C / COD. 011</p>
      <h1>FACTURA</h1>
      <p>Punto de Venta: 00001 Comp. Nro: 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>
      ${validFiscalRowsHtml}
      <p>CUIT: 20-00000000-1</p>
      ${sameCuitIdentifiedRecipientHtml}
      <p>Producto / Servicio Cantidad U. Medida Precio Unit. % Bonif. Imp. Bonif. Subtotal</p>
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Subtotal: $ 123456,78</p>
      <p>Importe Total: $ 123456,78</p>
      <p>Comprobante Autorizado</p>
      <p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: pdfPath, format: "A4" });
    const evidence = await inspectArcaInvoicePdf(pdfPath, {
      voucherType: "Factura C",
      pointOfSale: "00001",
      issueDate: "15/06/2030",
      ...expectedFiscalRows,
      issuerCuit: "20000000001",
      recipientCuit: "20000000001",
      description: "Servicio de prueba",
      amountCents: 12_345_678,
    });
    assert.equal(evidence.voucherNumber, "00001-00000042");
    assert.equal(evidence.cae, "99999999999999");
    assert.equal(evidence.pageCount, 1);

    const visualOrderPath = path.join(directory, "factura-orden-visual.pdf");
    await page.setContent(`
      <p>C / COD. 011</p><h1>FACTURA</h1>
      <p>Punto de Venta: 00001 Comp. Nro: 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20-00000000-1</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Subtotal: $ 123456,78</p>
      <div style="position: relative; height: 20px">
        <span style="position: absolute; left: 180px">123456,78</span>
        <span style="position: absolute; left: 0">Importe Total: $</span>
      </div>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: visualOrderPath, format: "A4" });
    const flattenedVisualOrderText = await extractFirstPageText(visualOrderPath);
    assert.equal(/Importe\s+Total\s*:?\s*\$?\s*123456,78/iu.test(flattenedVisualOrderText), false);
    assert.ok(flattenedVisualOrderText.lastIndexOf("123456,78") < flattenedVisualOrderText.indexOf("Importe Total"));
    const visualOrderEvidence = await inspectArcaInvoicePdf(visualOrderPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    });
    assert.equal(visualOrderEvidence.voucherNumber, "00001-00000042");
    assert.equal(visualOrderEvidence.cae, "99999999999999");

    const wrongVisualOrderPath = path.join(directory, "factura-orden-visual-total-incorrecto.pdf");
    await page.setContent(`
      <p>C / COD. 011</p><h1>FACTURA</h1>
      <p>Punto de Venta: 00001 Comp. Nro: 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20-00000000-1</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Subtotal: $ 123456,78</p>
      <div style="position: relative; height: 20px">
        <span style="position: absolute; left: 180px">246913,56</span>
        <span style="position: absolute; left: 0">Importe Total: $</span>
      </div>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: wrongVisualOrderPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(wrongVisualOrderPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /Importe Total esperado/);

    await assert.rejects(
      () => inspectArcaInvoicePdf(pdfPath, {
        voucherType: "Factura C",
        pointOfSale: "00001",
        issueDate: "15/06/2030",
        ...expectedFiscalRows,
        issuerCuit: "20000000001",
        recipientCuit: "20000000001",
        description: "Servicio de prueba",
        amountCents: 1,
      }),
      /Importe Total esperado/i,
    );

    const wrongTotalPath = path.join(directory, "factura-total-incorrecto.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1>
      <p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Subtotal: $ 123456,78</p><p>Importe Total: $ 246913,56</p>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: wrongTotalPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(wrongTotalPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /Importe Total esperado/);

    const duplicateTotalPath = path.join(directory, "factura-total-duplicado.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1><p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Importe Total: $ 123456,78</p><p>Importe Total: $ 123456,78</p>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: duplicateTotalPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(duplicateTotalPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /Importe Total esperado/);

    const ambiguousTotalPath = path.join(directory, "factura-total-ambiguo.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1><p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <div style="position: relative; height: 20px">
        <span style="position: absolute; left: 0">Importe Total: $</span>
        <span style="position: absolute; left: 180px">123456,78</span>
        <span style="position: absolute; left: 280px">123456,78</span>
      </div>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: ambiguousTotalPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(ambiguousTotalPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /Importe Total esperado/);

    const surroundingAmountsPath = path.join(directory, "factura-total-importe-a-cada-lado.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1><p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <div style="position: relative; height: 20px">
        <span style="position: absolute; left: 0">1,00</span>
        <span style="position: absolute; left: 90px">Importe Total: $</span>
        <span style="position: absolute; left: 270px">123456,78</span>
      </div>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: surroundingAmountsPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(surroundingAmountsPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /Importe Total esperado/);

    const malformedTotalPath = path.join(directory, "factura-total-separadores-incoherentes.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1><p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 1,00 unidades 3000000,00 0,00 0,00 3000000,00</p>
      <p>Importe Total: $ 3.000.000.00</p>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: malformedTotalPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(malformedTotalPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 300_000_000,
    }), /Importe Total esperado/);

    const wrongQuantityPath = path.join(directory, "factura-cantidad-incorrecta.pdf");
    await page.setContent(`
      <h1>FACTURA C</h1>
      <p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>${validFiscalRowsHtml}<p>CUIT: 20000000001</p>${sameCuitIdentifiedRecipientHtml}
      <p>Servicio de prueba 2,00 unidades 123456,78 0,00 0,00 123456,78</p>
      <p>Subtotal: $ 123456,78</p><p>Importe Total: $ 123456,78</p>
      <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: wrongQuantityPath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(wrongQuantityPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows, issuerCuit: "20000000001",
      recipientCuit: "20000000001", description: "Servicio de prueba", amountCents: 12_345_678,
    }), /cantidad 1/);
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rechaza mutaciones de cada dato fiscal y exige una única fila coherente de ítem", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-pdf-fiscal-mutations-");
  const page = await browser.newPage();
  const expectation = {
    voucherType: "Factura C",
    pointOfSale: "00001",
    issueDate: "15/06/2030",
    ...expectedFiscalRows,
    issuerCuit: "20000000001",
    recipientCuit: "27000000006",
    description: "Servicio técnico completamente ficticio",
    amountCents: 12_345_678,
  };
  const cases = [
    { name: "periodo-desde", mutation: { billingPeriodFrom: "02/06/2030" }, error: /valor esperado para inicio del período facturado/i },
    { name: "periodo-hasta", mutation: { billingPeriodTo: "29/06/2030" }, error: /valor esperado para fin del período facturado/i },
    { name: "vencimiento", mutation: { dueDate: "21/06/2030" }, error: /valor esperado para vencimiento/i },
    { name: "condicion-venta", mutation: { saleCondition: "Contado" }, error: /condición de venta esperada/i },
    { name: "descripcion", mutation: { description: "Otro servicio ficticio" }, error: /única fila visual/i },
    { name: "descripcion-prefijada", mutation: { description: "OTRO Servicio técnico completamente ficticio" }, error: /coincide exactamente con la descripción/i },
    { name: "cantidad", mutation: { quantity: "2,00" }, error: /cantidad 1/i },
    { name: "precio-unitario", mutation: { unitPrice: "123455,78" }, error: /precio unitario esperado/i },
    { name: "subtotal-item", mutation: { itemSubtotal: "123455,78" }, error: /subtotal esperado/i },
    { name: "fila-item-duplicada", mutation: { duplicateItemRow: true }, error: /única fila visual/i },
    { name: "periodo-duplicado", mutation: { duplicatePeriodRow: true }, error: /única fila etiquetada de período facturado/i },
    { name: "vencimiento-duplicado", mutation: { duplicateDueDateRow: true }, error: /única fila etiquetada de vencimiento/i },
    { name: "venta-duplicada", mutation: { duplicateSaleConditionRow: true }, error: /única fila etiquetada de condición de venta/i },
  ] as const;
  try {
    for (const fixture of cases) {
      const pdfPath = path.join(directory, `${fixture.name}.pdf`);
      await page.setContent(buildSyntheticFiscalInvoiceHtml(fixture.mutation));
      await page.pdf({ path: pdfPath, format: "A4" });
      await assert.rejects(() => inspectArcaInvoicePdf(pdfPath, expectation), fixture.error, fixture.name);
    }

    const wrongLabeledIssueDatePath = path.join(directory, "fecha-emision-etiquetada-incorrecta.pdf");
    await page.setContent(buildSyntheticFiscalInvoiceHtml({ issueDate: "29/06/2030" }));
    await page.pdf({ path: wrongLabeledIssueDatePath, format: "A4" });
    await assert.rejects(
      () => inspectArcaInvoicePdf(wrongLabeledIssueDatePath, { ...expectation, issueDate: expectedFiscalRows.billingPeriodTo }),
      /valor esperado para fecha de emisión/i,
    );
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("el PDF de un Consumidor Final anónimo exige un bloque receptor único, vacío y separado del emisor", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-anonymous-final-consumer-pdf-");
  const page = await browser.newPage();
  const expectation = {
    voucherType: "Factura C",
    pointOfSale: "00001",
    issueDate: "15/06/2030",
    ...expectedFiscalRows,
    issuerCuit: "20000000001",
    recipientKind: "anonymous-final-consumer" as const,
    description: "Servicio profesional totalmente ficticio",
    amountCents: 12_345_678,
  };
  const common = `
    <p>C / COD. 011</p><h1>FACTURA</h1>
    <p>Razón Social: EMISOR TOTALMENTE FICTICIO</p>
    <p>CUIT: 20-00000000-1</p>
    <p>Domicilio Comercial: Avenida Ficción 100</p>
    <p>Condición frente al IVA: Responsable Monotributo</p>
    <p>Punto de Venta: 00001 Comp. Nro: 00000042</p>
    <p>Fecha de Emisión: 15/06/2030</p>
    ${validFiscalRowsHtml}
    <p>Servicio profesional totalmente ficticio 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
    <p>Subtotal: $ 123456,78</p><p>Importe Total: $ 123456,78</p>
    <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
  `;
  const anonymousIdentityWithoutCuit = `<p>Doc.: - Apellido y Nombre / Razón Social:</p>`;
  const anonymousIdentityWithBlankCuit = `<p><span>CUIT:</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social:</span></p>`;
  const anonymousVatAndAddress = `<p><span>Condición frente al IVA: Consumidor Final</span><span style="margin-left: 180px">Domicilio:</span></p>`;
  try {
    for (const [name, identity] of [
      ["anonimo-sin-etiqueta-cuit", anonymousIdentityWithoutCuit],
      ["anonimo-con-documento-no-informado-espaciado", `<p>Doc . :   - Apellido y Nombre / Razón Social:</p>`],
      ["anonimo-con-etiqueta-cuit-vacia", anonymousIdentityWithBlankCuit],
    ] as const) {
      const validPath = path.join(directory, `${name}.pdf`);
      await page.setContent(`${common}${identity}${anonymousVatAndAddress}`);
      await page.pdf({ path: validPath, format: "A4" });
      const evidence = await inspectArcaInvoicePdf(validPath, expectation);
      assert.equal(evidence.voucherNumber, "00001-00000042", name);
    }

    const missingPath = path.join(directory, "anonimo-sin-condicion.pdf");
    await page.setContent(`${common}${anonymousIdentityWithoutCuit}`);
    await page.pdf({ path: missingPath, format: "A4" });
    await assert.rejects(
      () => inspectArcaInvoicePdf(missingPath, expectation),
      /bloque único y completo/i,
    );

    const duplicatePath = path.join(directory, "anonimo-condicion-duplicada.pdf");
    await page.setContent(`${common}${anonymousIdentityWithoutCuit}${anonymousVatAndAddress}${anonymousVatAndAddress}`);
    await page.pdf({ path: duplicatePath, format: "A4" });
    await assert.rejects(
      () => inspectArcaInvoicePdf(duplicatePath, expectation),
      /bloque único y completo/i,
    );

    const invalidRecipientBlocks = [
      {
        name: "anonimo-cuit-no-vacio",
        block: `<p><span>CUIT: 27-00000000-6</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social:</span></p>${anonymousVatAndAddress}`,
        error: /contiene un CUIT/i,
      },
      {
        name: "anonimo-nombre-no-vacio",
        block: `<p>Doc.: - Apellido y Nombre / Razón Social: PERSONA FICTICIA</p>${anonymousVatAndAddress}`,
        error: /contiene CUIT, nombre o domicilio/i,
      },
      {
        name: "anonimo-domicilio-no-vacio",
        block: `${anonymousIdentityWithoutCuit}<p><span>Condición frente al IVA: Consumidor Final</span><span style="margin-left: 180px">Domicilio: Calle Ficticia 123</span></p>`,
        error: /contiene CUIT, nombre o domicilio/i,
      },
      {
        name: "anonimo-identidad-duplicada",
        block: `${anonymousIdentityWithoutCuit}${anonymousIdentityWithoutCuit}${anonymousVatAndAddress}`,
        error: /bloque único y completo/i,
      },
      {
        name: "anonimo-cuit-separado",
        block: `${anonymousIdentityWithoutCuit}<p>CUIT:</p>${anonymousVatAndAddress}`,
        error: /CUIT adicionales o ambiguas/i,
      },
      {
        name: "anonimo-cuit-ambiguo",
        block: `<p><span>CUIT:</span><span style="margin-left: 90px">CUIT:</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social:</span></p>${anonymousVatAndAddress}`,
        error: /más de una etiqueta CUIT/i,
      },
      {
        name: "anonimo-sin-fila-identidad",
        block: anonymousVatAndAddress,
        error: /bloque único y completo/i,
      },
      {
        name: "anonimo-sin-domicilio-etiquetado",
        block: `${anonymousIdentityWithoutCuit}<p>Condición frente al IVA: Consumidor Final</p>`,
        error: /bloque único y completo/i,
      },
      {
        name: "anonimo-filas-no-contiguas",
        block: `${anonymousIdentityWithoutCuit}<p>Fila intermedia ficticia</p>${anonymousVatAndAddress}`,
        error: /conserva juntas/i,
      },
      {
        name: "anonimo-condicion-iva-incorrecta",
        block: `${anonymousIdentityWithoutCuit}<p><span>Condición frente al IVA: Monotributo</span><span style="margin-left: 180px">Domicilio:</span></p>`,
        error: /Consumidor Final sin identificar/i,
      },
      {
        name: "anonimo-documento-prefijado-en-identidad",
        block: `<p>DNI: 123 Apellido y Nombre / Razón Social:</p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-sin-cuit-ni-marcador-doc",
        block: `<p>Apellido y Nombre / Razón Social:</p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-doc-informado-en-identidad",
        block: `<p>Doc.: 123 Apellido y Nombre / Razón Social:</p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-dni-no-informado-en-identidad",
        block: `<p>DNI: - Apellido y Nombre / Razón Social:</p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-doc-sin-punto-en-identidad",
        block: `<p>Doc: - Apellido y Nombre / Razón Social:</p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-doc-prefijado-con-cuit-vacio",
        block: `<p><span>Doc.: -</span><span style="margin-left: 90px">CUIT:</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social:</span></p>${anonymousVatAndAddress}`,
        error: /texto inesperado/i,
      },
      {
        name: "anonimo-documento-prefijado-en-condicion",
        block: `${anonymousIdentityWithoutCuit}<p>Documento: 123 <span>Condición frente al IVA: Consumidor Final</span><span style="margin-left: 180px">Domicilio:</span></p>`,
        error: /texto inesperado/i,
      },
    ] as const;
    for (const fixture of invalidRecipientBlocks) {
      const invalidPath = path.join(directory, `${fixture.name}.pdf`);
      await page.setContent(`${common}${fixture.block}`);
      await page.pdf({ path: invalidPath, format: "A4" });
      await assert.rejects(
        () => inspectArcaInvoicePdf(invalidPath, expectation),
        fixture.error,
        fixture.name,
      );
    }

    const wrongIssuerPath = path.join(directory, "emisor-incorrecto.pdf");
    await page.setContent(`${common.replace("20-00000000-1", "27-00000000-6")}${anonymousIdentityWithoutCuit}${anonymousVatAndAddress}`);
    await page.pdf({ path: wrongIssuerPath, format: "A4" });
    await assert.rejects(
      () => inspectArcaInvoicePdf(wrongIssuerPath, expectation),
      /CUIT etiquetado e inmediato para el emisor/i,
    );
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("valida todas las páginas y exige comprobante, CAE y CUIT coherentes por página", async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await makeCanonicalTemporaryDirectory("arca-multipage-invoice-pdf-");
  const page = await browser.newPage();
  const anonymousExpectation = {
    voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows,
    issuerCuit: "20000000001", recipientKind: "anonymous-final-consumer" as const,
    description: "Servicio multipágina ficticio", amountCents: 12_345_678,
  };
  const validAnonymousPage = buildSyntheticAnonymousInvoicePage();
  try {
    const validPath = path.join(directory, "anonimo-tres-paginas-valido.pdf");
    await page.setContent(buildSyntheticMultipageHtml([validAnonymousPage, validAnonymousPage, validAnonymousPage]));
    await page.pdf({ path: validPath, format: "A4" });
    assert.match(
      await extractFirstPageText(validPath),
      /CAE\s+N°:\s+Fecha\s+de\s+Vto\.\s+de\s+CAE:\s+99999999999999/iu,
    );
    const evidence = await inspectArcaInvoicePdf(validPath, anonymousExpectation);
    assert.equal(evidence.pageCount, 3);
    assert.equal(evidence.voucherNumber, "00001-00000042");
    assert.equal(evidence.cae, "99999999999999");

    const validIdentifiedPage = buildSyntheticFiscalInvoiceHtml({});
    const identifiedPath = path.join(directory, "identificado-dos-paginas-valido.pdf");
    await page.setContent(buildSyntheticMultipageHtml([validIdentifiedPage, validIdentifiedPage]));
    await page.pdf({ path: identifiedPath, format: "A4" });
    assert.equal((await inspectArcaInvoicePdf(identifiedPath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows,
      issuerCuit: "20000000001", recipientCuit: "27000000006",
      description: "Servicio técnico completamente ficticio", amountCents: 12_345_678,
    })).pageCount, 2);

    const invalidCases = [
      {
        name: "mutacion-fecha-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ issueDate: "16/06/2030" }), validAnonymousPage],
        error: /fecha de emisión/i,
      },
      {
        name: "mutacion-total-pagina-3",
        pages: [validAnonymousPage, validAnonymousPage, buildSyntheticAnonymousInvoicePage({ total: "123455,78" })],
        error: /Importe Total esperado/i,
      },
      {
        name: "voucher-discrepante-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ voucherNumber: "00000043" }), validAnonymousPage],
        error: /no coinciden en número de comprobante y CAE/i,
      },
      {
        name: "cae-discrepante-pagina-3",
        pages: [validAnonymousPage, validAnonymousPage, buildSyntheticAnonymousInvoicePage({ cae: "8".repeat(14) })],
        error: /no coinciden en número de comprobante y CAE/i,
      },
      {
        name: "voucher-identico-duplicado-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ duplicateVoucher: true }), validAnonymousPage],
        error: /único punto de venta y número etiquetados/i,
      },
      {
        name: "cae-identico-duplicado-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ duplicateCae: true }), validAnonymousPage],
        error: /única ocurrencia etiquetada de CAE/i,
      },
      {
        name: "cae-malformado-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ cae: "9999999999999" }), validAnonymousPage],
        error: /valor inmediato de 14 dígitos/i,
      },
      {
        name: "solo-vencimiento-cae-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({ omitCae: true }), validAnonymousPage],
        error: /única ocurrencia etiquetada de CAE/i,
      },
      {
        name: "doble-cuit-pagina-2",
        pages: [validAnonymousPage, buildSyntheticAnonymousInvoicePage({
          cuitRows: `<p>CUIT: 20-00000000-1 CUIT: 20-00000000-1</p>${anonymousRecipientRowsHtml}`,
        }), validAnonymousPage],
        error: /más de una etiqueta CUIT/i,
      },
      {
        name: "cuit-extra-pagina-3",
        pages: [validAnonymousPage, validAnonymousPage, buildSyntheticAnonymousInvoicePage({
          cuitRows: `<p>CUIT: 20-00000000-1</p><p>CUIT: 27-00000000-6</p>${anonymousRecipientRowsHtml}`,
        })],
        error: /CUIT adicionales o ambiguas/i,
      },
    ] as const;
    for (const fixture of invalidCases) {
      const invalidPath = path.join(directory, `${fixture.name}.pdf`);
      await page.setContent(buildSyntheticMultipageHtml([...fixture.pages]));
      await page.pdf({ path: invalidPath, format: "A4" });
      await assert.rejects(() => inspectArcaInvoicePdf(invalidPath, anonymousExpectation), fixture.error, fixture.name);
    }

    const identifiedWrongImmediatePath = path.join(directory, "identificado-cuit-no-inmediato-pagina-2.pdf");
    await page.setContent(buildSyntheticMultipageHtml([
      validIdentifiedPage,
      validIdentifiedPage.replace("CUIT: 27-00000000-6", "CUIT: Documento 27-00000000-6"),
    ]));
    await page.pdf({ path: identifiedWrongImmediatePath, format: "A4" });
    await assert.rejects(() => inspectArcaInvoicePdf(identifiedWrongImmediatePath, {
      voucherType: "Factura C", pointOfSale: "00001", issueDate: "15/06/2030", ...expectedFiscalRows,
      issuerCuit: "20000000001", recipientCuit: "27000000006",
      description: "Servicio técnico completamente ficticio", amountCents: 12_345_678,
    }), /CUIT etiquetado e inmediato para el receptor/i);
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("la expectativa PDF se construye desde el mismo discriminante usado por emisión y recuperación", () => {
  const common = {
    schemaVersion: 2 as const,
    operationId: "test-anonymous-expectation-001",
    issuerKey: "20000000001",
    recipientKind: "anonymous-final-consumer" as const,
    recipientVatCondition: "Consumidor Final" as const,
    voucherType: "Factura C",
    pointOfSale: "00009",
    date: "2030-06-15",
    concept: "Servicios",
    currency: "ARS" as const,
    billingPeriodFrom: "2030-06-01",
    billingPeriodTo: "2030-06-30",
    dueDate: "2030-06-20",
    saleCondition: "Transferencia Bancaria",
    description: "Servicio profesional totalmente ficticio",
    amount: 123_456.78,
    amountCents: 12_345_678,
    amountDecimal: "123456.78",
    outputDir: path.resolve("artifacts/pdf/emisor-prueba/2030-06"),
  };
  assert.deepEqual(buildArcaInvoicePdfExpectation(common), {
    voucherType: "Factura C",
    pointOfSale: "00009",
    issueDate: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    dueDate: "20/06/2030",
    saleCondition: "Transferencia Bancaria",
    issuerCuit: "20000000001",
    recipientKind: "anonymous-final-consumer",
    description: "Servicio profesional totalmente ficticio",
    amountCents: 12_345_678,
  });
});

test("la recuperación exige coincidencia con cualquier número o CAE parcial del ledger unknown", () => {
  const evidence = { voucherNumber: "00001-00000042", cae: "99999999999999" };
  assert.doesNotThrow(() => assertArcaInvoicePdfMatchesKnownReceipt(evidence, undefined));
  assert.doesNotThrow(() => assertArcaInvoicePdfMatchesKnownReceipt(evidence, { voucherNumber: evidence.voucherNumber }));
  assert.doesNotThrow(() => assertArcaInvoicePdfMatchesKnownReceipt(evidence, { cae: evidence.cae }));
  assert.throws(
    () => assertArcaInvoicePdfMatchesKnownReceipt(evidence, { voucherNumber: evidence.voucherNumber.replace(/42$/u, "41") }),
    /número.*ledger unknown/i,
  );
  assert.throws(
    () => assertArcaInvoicePdfMatchesKnownReceipt(evidence, { cae: "1".repeat(14) }),
    /CAE.*ledger unknown/i,
  );
});

type SyntheticAnonymousInvoicePageMutation = {
  issueDate?: string;
  voucherNumber?: string;
  cae?: string;
  total?: string;
  cuitRows?: string;
  duplicateVoucher?: boolean;
  duplicateCae?: boolean;
  omitCae?: boolean;
};

function buildSyntheticAnonymousInvoicePage(mutation: SyntheticAnonymousInvoicePageMutation = {}): string {
  const voucherRow = `<p>Punto de Venta: 00001 Comp. Nro: ${mutation.voucherNumber ?? "00000042"}</p>`;
  const caeValue = mutation.cae ?? "99999999999999";
  const caeReceiptLabel = mutation.omitCae ? "" : `<span style="position: absolute; left: 0; top: 24px">CAE N°:</span>`;
  const caeReceiptValue = mutation.omitCae ? "" : `<span style="position: absolute; left: 110px; top: 24px">${caeValue}</span>`;
  const duplicateCaeReceiptRow = mutation.duplicateCae ? `
    <span style="position: absolute; left: 0; top: 48px">CAE N°:</span>
    <span style="position: absolute; left: 110px; top: 48px">${caeValue}</span>` : "";
  return `
    <p>C / COD. 011</p><h1>FACTURA</h1>
    ${voucherRow}${mutation.duplicateVoucher ? voucherRow : ""}
    <p>Fecha de Emisión: ${mutation.issueDate ?? "15/06/2030"}</p>
    ${validFiscalRowsHtml}
    ${mutation.cuitRows ?? `<p>CUIT: 20-00000000-1</p>${anonymousRecipientRowsHtml}`}
    <p>Servicio multipágina ficticio 1,00 unidades 123456,78 0,00 0,00 123456,78</p>
    <p>Subtotal: $ 123456,78</p><p>Importe Total: $ ${mutation.total ?? "123456,78"}</p>
    <p>Comprobante Autorizado</p>
    <div style="position: relative; height: ${mutation.duplicateCae ? 72 : 48}px">
      ${caeReceiptLabel}
      <span style="position: absolute; left: 0; top: 0">Fecha de Vto. de CAE:</span>
      ${caeReceiptValue}
      <span style="position: absolute; left: 180px; top: 0">30/06/2030</span>
      ${duplicateCaeReceiptRow}
    </div>
  `;
}

function buildSyntheticMultipageHtml(pages: readonly string[]): string {
  return `<style>.invoice-page { break-after: page; } .invoice-page:last-child { break-after: auto; }</style>${pages
    .map((content) => `<section class="invoice-page">${content}</section>`)
    .join("")}`;
}

type SyntheticFiscalInvoiceMutation = {
  issueDate?: string;
  billingPeriodFrom?: string;
  billingPeriodTo?: string;
  dueDate?: string;
  saleCondition?: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  itemSubtotal?: string;
  duplicateItemRow?: boolean;
  duplicatePeriodRow?: boolean;
  duplicateDueDateRow?: boolean;
  duplicateSaleConditionRow?: boolean;
};

function buildSyntheticFiscalInvoiceHtml(mutation: SyntheticFiscalInvoiceMutation): string {
  const issueDate = mutation.issueDate ?? "15/06/2030";
  const billingPeriodFrom = mutation.billingPeriodFrom ?? expectedFiscalRows.billingPeriodFrom;
  const billingPeriodTo = mutation.billingPeriodTo ?? expectedFiscalRows.billingPeriodTo;
  const dueDate = mutation.dueDate ?? expectedFiscalRows.dueDate;
  const saleCondition = mutation.saleCondition ?? expectedFiscalRows.saleCondition;
  const description = mutation.description ?? "Servicio técnico completamente ficticio";
  const quantity = mutation.quantity ?? "1,00";
  const unitPrice = mutation.unitPrice ?? "123456,78";
  const itemSubtotal = mutation.itemSubtotal ?? "123456,78";
  const periodRow = `<p>Período Facturado Desde: ${billingPeriodFrom} Hasta: ${billingPeriodTo}</p>`;
  const dueDateRow = `<p>Fecha de Vto. para el pago: ${dueDate}</p>`;
  const saleConditionRow = `<p>Condición de venta: ${saleCondition}</p>`;
  const itemRow = `<p>${description} ${quantity} unidades ${unitPrice} 0,00 0,00 ${itemSubtotal}</p>`;
  return `
    <p>C / COD. 011</p><h1>FACTURA</h1>
    <p>Punto de Venta: 00001 Comp. Nro: 00000042</p>
    <p>Fecha de Emisión: ${issueDate}</p>
    <p>CUIT: 20-00000000-1</p>
    <p><span>CUIT: 27-00000000-6</span><span style="margin-left: 180px">Apellido y Nombre / Razón Social: RECEPTOR FICTICIO</span></p>
    ${periodRow}${mutation.duplicatePeriodRow ? periodRow : ""}
    ${dueDateRow}${mutation.duplicateDueDateRow ? dueDateRow : ""}
    ${saleConditionRow}${mutation.duplicateSaleConditionRow ? saleConditionRow : ""}
    <p>Producto / Servicio Cantidad U. Medida Precio Unit. % Bonif. Imp. Bonif. Subtotal</p>
    ${itemRow}${mutation.duplicateItemRow ? itemRow : ""}
    <p>Subtotal: $ 123456,78</p><p>Importe Total: $ 123456,78</p>
    <p>Comprobante Autorizado</p><p>CAE N°: 99999999999999</p>
  `;
}

async function extractFirstPageText(pdfPath: string): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(await fs.readFile(pdfPath)),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    return content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
  } finally {
    await task.destroy();
  }
}
