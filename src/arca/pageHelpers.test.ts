import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { candidate, classifyArcaAccessFailure, selectOptionContaining, waitForAnyVisible, waitForUniqueSelectedEnabledOptionByVisibleText } from "./pageHelpers.js";

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

test("espera en solo lectura el CUIT que ARCA carga y preselecciona de forma asíncrona", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <select id="tipo-documento">
        <option selected>DNI</option>
      </select>
      <script>
        const select = document.querySelector('#tipo-documento');
        select.addEventListener('change', () => { document.body.dataset.documentTypeChanged = '1'; });
        setTimeout(() => {
          select.innerHTML = '<option>DNI</option><option selected>CUIT</option>';
        }, 40);
      </script>
    `);

    const selected = await waitForUniqueSelectedEnabledOptionByVisibleText(
      page.locator("#tipo-documento"),
      "CUIT",
      "tipo de documento",
      1000,
    );

    assert.equal(selected, "CUIT");
    assert.equal(((await page.locator("#tipo-documento option:checked").textContent()) ?? "").trim(), "CUIT");
    assert.equal(await page.locator("#tipo-documento option:checked").isEnabled(), true);
    assert.equal(await page.locator("body").getAttribute("data-document-type-changed"), null);
  } finally {
    await browser.close();
  }
});

test("bloquea CUIT ausente, no preseleccionado, duplicado o deshabilitado", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<select id="tipo-documento"><option selected>DNI</option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /no mostró una opción única "CUIT"/i,
    );

    await page.setContent('<select id="tipo-documento"><option selected>DNI</option><option>CUIT</option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /"CUIT" no quedó preseleccionada/i,
    );

    await page.setContent('<select id="tipo-documento"><option selected>CUIT</option><option>CUIT</option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /mostró 2 opciones "CUIT"/i,
    );

    for (const cuitMarkup of [
      '<option disabled selected>CUIT</option>',
      '<optgroup label="No disponible" disabled><option selected>CUIT</option></optgroup>',
    ]) {
      await page.setContent(`<select id="tipo-documento">${cuitMarkup}</select>`);
      await assert.rejects(
        () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
        /única opción "CUIT" está deshabilitada/i,
      );
    }
  } finally {
    await browser.close();
  }
});

test("bloquea cualquier opción de texto vacío como variante no aprendida", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<select id="tipo-documento"><option selected>CUIT</option><option> </option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /opción de texto vacío.*variante no aprendida/i,
    );
  } finally {
    await browser.close();
  }
});

test("bloquea el selector documental deshabilitado o con múltiples opciones seleccionadas", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<select id="tipo-documento" disabled><option selected>CUIT</option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /selector de documento está deshabilitado/i,
    );

    await page.setContent('<select id="tipo-documento" multiple><option selected>CUIT</option><option selected>DNI</option></select>');
    await assert.rejects(
      () => waitForUniqueSelectedEnabledOptionByVisibleText(page.locator("#tipo-documento"), "CUIT", "tipo de documento", 75),
      /más de una opción seleccionada/i,
    );
  } finally {
    await browser.close();
  }
});
