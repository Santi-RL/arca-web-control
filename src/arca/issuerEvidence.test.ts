import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  assertIssuerEvidenceMatches,
  captureIssuerControlEvidence,
  extractIssuerSummaryEvidence,
} from "./issuerEvidence.js";

const issuerCuit = "20000000001";
const otherValidCuit = "27000000006";

test("extrae razón social y domicilio solo del bloque Datos del Emisor realista, que no contiene CUIT", () => {
  const evidence = extractIssuerSummaryEvidence(`
    Representando a: ${otherValidCuit} - TEXTO AJENO
    Datos del Emisor
    Logo Preimpreso  No
    Razón Social  EMISOR TOTALMENTE FICTICIO
    Punto de Venta  00001
    Domicilio  Avenida Ficción 100, CABA
    Datos del Receptor
    CUIT  ${otherValidCuit}
    Razón Social  RECEPTOR TOTALMENTE FICTICIO
    Domicilio Comercial  Calle Distinta 900, CABA
  `);

  assert.deepEqual(evidence, {
    issuer: "EMISOR TOTALMENTE FICTICIO",
    issuerCommercialAddress: "Avenida Ficción 100, CABA",
  });
});

test("el bloque Datos del Emisor falla si falta, se duplica o no tiene domicilio", () => {
  assert.throws(() => extractIssuerSummaryEvidence("Datos del Receptor\nCUIT 27000000006"), /Datos del Emisor.*0/i);
  assert.throws(() => extractIssuerSummaryEvidence(`
    Datos del Emisor
    Razón Social EMISOR FICTICIO
    Domicilio Avenida Ficción 100
    Datos del Emisor
    Razón Social OTRO EMISOR FICTICIO
    Domicilio Calle Ficción 200
    Datos del Receptor
  `), /Datos del Emisor.*2/i);
  assert.throws(() => extractIssuerSummaryEvidence(`
    Datos del Emisor
    Razón Social EMISOR FICTICIO
    Datos del Receptor
  `), /campo Domicilio.*0/i);
});

test("la evidencia del resumen exige coincidencia entre control, sesión, job y credencial", () => {
  const summaryBlock = {
    issuer: "EMISOR TOTALMENTE FICTICIO",
    issuerCommercialAddress: "Avenida Ficción 100, CABA",
  };
  const verified = assertIssuerEvidenceMatches(
    summaryBlock,
    { issuer: "Emisor Totalmente Ficticio", issuerCuit },
    [issuerCuit, issuerCuit, issuerCuit],
  );
  assert.deepEqual(verified, { ...summaryBlock, issuerCuit });

  assert.throws(() => assertIssuerEvidenceMatches(
    summaryBlock,
    { issuer: "EMISOR TOTALMENTE FICTICIO", issuerCuit },
    [issuerCuit, otherValidCuit, issuerCuit],
  ), /sesión, el job y la credencial/i);
  assert.throws(() => assertIssuerEvidenceMatches(
    summaryBlock,
    { issuer: "OTRO EMISOR FICTICIO", issuerCuit },
    [issuerCuit, issuerCuit, issuerCuit],
  ), /razón social.*no coincide/i);
});

test("captura un único Representando a y rechaza ausencia, duplicados o CUIT discrepante", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const url = "https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp";
    await page.route(url, (route) => route.fulfill({
      contentType: "text/html",
      body: `<p>Representando a: ${issuerCuit} - EMISOR TOTALMENTE FICTICIO</p>`,
    }));
    await page.goto(url);
    assert.deepEqual(await captureIssuerControlEvidence(page, issuerCuit), {
      issuer: "EMISOR TOTALMENTE FICTICIO",
      issuerCuit,
    });

    await page.setContent("<p>Sin identidad visible</p>");
    await assert.rejects(() => captureIssuerControlEvidence(page, issuerCuit), /se encontraron 0/i);

    await page.setContent(`<p>Representando a: ${issuerCuit} - EMISOR FICTICIO</p><p>Representando a: ${issuerCuit} - EMISOR FICTICIO</p>`);
    await assert.rejects(() => captureIssuerControlEvidence(page, issuerCuit), /se encontraron 2/i);

    await page.setContent(`<p>Representando a: ${otherValidCuit} - OTRO EMISOR FICTICIO</p>`);
    await assert.rejects(() => captureIssuerControlEvidence(page, issuerCuit), /no coincide con el job/i);
  } finally {
    await browser.close();
  }
});
