import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { chromium } from "playwright";
import { reservePrivatePdfDestination } from "../config/privateDownloads.js";
import { downloadGeneratedInvoicePdf, inspectArcaInvoicePdf } from "./invoicePdf.js";

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
      <h1>FACTURA C</h1>
      <p>Punto de Venta: Comp. Nro: 00001 00000042</p>
      <p>Fecha de Emisión: 15/06/2030</p>
      <p>CUIT: 20000000001</p>
      <p>Servicio de prueba</p>
      <p>Importe Total: $ 123456,78</p>
      <p>Comprobante Autorizado</p>
      <p>CAE N°: 99999999999999</p>
    `);
    await page.pdf({ path: pdfPath, format: "A4" });
    const evidence = await inspectArcaInvoicePdf(pdfPath, {
      voucherType: "Factura C",
      pointOfSale: "00001",
      issueDate: "15/06/2030",
      recipientCuit: "20000000001",
      description: "Servicio de prueba",
      amountCents: 12_345_678,
    });
    assert.equal(evidence.voucherNumber, "00001-00000042");
    assert.equal(evidence.cae, "99999999999999");
    assert.equal(evidence.pageCount, 1);

    await assert.rejects(
      () => inspectArcaInvoicePdf(pdfPath, {
        voucherType: "Factura C",
        pointOfSale: "00001",
        issueDate: "15/06/2030",
        recipientCuit: "20000000001",
        description: "Servicio de prueba",
        amountCents: 1,
      }),
      /importe esperado/i,
    );
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
