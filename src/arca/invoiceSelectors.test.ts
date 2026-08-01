import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { initialVoucherTypeSelector, selectActivityIfNeeded, selectInitialVoucherData } from "./invoice.js";
import { ResolvedInvoiceJob } from "../types.js";
import { captureCurrencyEvidence, captureRecipientEvidence } from "./controlEvidence.js";
import { selectOptionContaining } from "./pageHelpers.js";

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

test("la selección de punto de venta tolera la recarga y relee una única Factura C habilitada", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.route("**/rcel/jsp/buscarPtosVtas*", (route) => {
      const selectedPointOfSale = new URL(route.request().url()).searchParams.get("pos") ?? "";
      const voucherOptions = selectedPointOfSale === "2"
        ? '<option value="">seleccionar...</option><option value="11">Factura C</option>'
        : '<option value=""></option>';
      return route.fulfill({
        contentType: "text/html",
        body: `
          <select id="puntodeventa" name="puntodeventa" onchange="location.assign('/rcel/jsp/buscarPtosVtas?pos=' + this.value)">
            <option value="">seleccionar...</option>
            <option value="1">00001-Domicilio ficticio</option>
            <option value="2" ${selectedPointOfSale === "2" ? "selected" : ""}>00002-Domicilio ficticio</option>
          </select>
          <select id="universocomprobante" name="universoComprobante">${voucherOptions}</select>
          <button id="continuar" onclick="document.body.dataset.continued='1'">Continuar</button>
        `,
      });
    });
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas");

    await selectInitialVoucherData(page, "00002", "Factura C");

    assert.equal(await page.locator("#puntodeventa option:checked").textContent(), "00002-Domicilio ficticio");
    assert.equal(await page.locator("#universocomprobante option:checked").textContent(), "Factura C");
    assert.equal(await page.locator("#universocomprobante option:checked").isEnabled(), true);
    assert.equal(await page.locator("body").getAttribute("data-continued"), null);
  } finally {
    await browser.close();
  }
});

test("espera una actualización AJAX lenta y no decide usando tipos viejos de otro punto de venta", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas", `
      <select id="puntodeventa" name="puntodeventa">
        <option value="1" selected>00001-Domicilio ficticio</option>
        <option value="2">00002-Domicilio ficticio</option>
      </select>
      <select id="universocomprobante" name="universoComprobante">
        <option value="19">Factura E</option>
      </select>
      <script>
        document.querySelector('#puntodeventa').addEventListener('change', () => setTimeout(() => {
          document.querySelector('#universocomprobante').innerHTML = '<option value="11">Factura C</option>';
        }, 350));
      </script>
    `);

    await selectInitialVoucherData(page, "00002", "Factura C");

    assert.equal(await page.locator("#puntodeventa option:checked").textContent(), "00002-Domicilio ficticio");
    assert.equal(await page.locator("#universocomprobante option:checked").textContent(), "Factura C");
  } finally {
    await browser.close();
  }
});

test("bloquea antes de continuar si el punto de venta no ofrece una única Factura C habilitada", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas", `
      <select id="puntodeventa" name="puntodeventa">
        <option value="">seleccionar...</option>
        <option value="1" selected>00001-Domicilio ficticio</option>
      </select>
      <select id="universocomprobante" name="universoComprobante">
        <option value="">seleccionar...</option>
        <option value="19">Factura E</option>
        <option value="11" disabled>Factura C</option>
      </select>
      <button id="continuar" onclick="document.body.dataset.continued='1'">Continuar</button>
    `);

    await assert.rejects(
      () => selectInitialVoucherData(page, "00001", "Factura C"),
      /no ofrece una única opción habilitada Factura C.*Tipos disponibles: Factura E \| Factura C \(deshabilitada\).*No se continuará/i,
    );
    assert.equal(await page.locator("body").getAttribute("data-continued"), null);

    await page.locator("#universocomprobante").evaluate((select) => {
      select.innerHTML = '<option value="11">Factura C</option><option value="12">Factura C</option>';
    });
    await assert.rejects(
      () => selectInitialVoucherData(page, "00001", "Factura C"),
      /no ofrece una única opción habilitada Factura C.*Factura C \| Factura C/i,
    );
    assert.equal(await page.locator("body").getAttribute("data-continued"), null);
  } finally {
    await browser.close();
  }
});

test("bloquea un punto de venta exacto deshabilitado antes de seleccionar el tipo o continuar", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas", `
      <select id="puntodeventa" name="puntodeventa">
        <option value="">seleccionar...</option>
        <option value="1" disabled>00001-Domicilio ficticio</option>
      </select>
      <select id="universocomprobante" name="universoComprobante" onchange="document.body.dataset.voucherChanged='1'">
        <option value="11">Factura C</option>
      </select>
      <button id="continuar" onclick="document.body.dataset.continued='1'">Continuar</button>
    `);

    await assert.rejects(
      () => selectInitialVoucherData(page, "00001", "Factura C"),
      /opción exacta y única.*deshabilitada.*habilitada/i,
    );
    assert.equal(await page.locator("#universocomprobante option:checked").textContent(), "Factura C");
    assert.equal(await page.locator("body").getAttribute("data-voucher-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-continued"), null);
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

test("la evidencia del receptor anónimo exige IVA, CUIT predeterminado y datos identificatorios vacíos", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const job = {
    recipientKind: "anonymous-final-consumer",
    recipientVatCondition: "Consumidor Final",
  } as ResolvedInvoiceJob;
  try {
    await loadRcelFixture(page, "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do", `
      <label>Condición frente al IVA
        <select id="idivareceptor" name="ivaReceptor">
          <option selected>Consumidor Final</option>
          <option>IVA Responsable Inscripto</option>
        </select>
      </label>
      <label>Tipo de documento
        <select id="idtipodocreceptor" name="tipoDoc">
          <option value="80" selected>CUIT</option>
          <option value="96">DNI</option>
        </select>
      </label>
      <label>Número <input id="nrodocreceptor"></label>
      <label>Razón Social <input id="razonsocialreceptor"></label>
      <label>Domicilio Comercial <input id="domicilioInput" name="domicilioReceptor"></label>
      <label>Email <input id="email" name="emailReceptor"></label>
      <label>Punto de venta asociado <input name="cmpAsociadoPtoVta"></label>
      <label>Número asociado <input name="cmpAsociadoNro"></label>
      <label>Fecha asociada <input name="cmpAsociadoFechaEmision"></label>
    `);

    assert.deepEqual(await captureRecipientEvidence(page, job), {
      recipientKind: "anonymous-final-consumer",
      recipientVatCondition: "Consumidor Final",
      recipientDocumentTypeDefault: "CUIT",
      recipientDocumentNumberBlank: true,
      recipientNameBlank: true,
      recipientCommercialAddressBlank: true,
      recipientEmailBlank: true,
      recipientAssociatedVoucherAbsent: true,
    });

    await page.locator("#idtipodocreceptor option").filter({ hasText: /^CUIT$/ }).evaluate((option) => {
      (option as HTMLOptionElement).disabled = true;
    });
    await assert.rejects(() => captureRecipientEvidence(page, job), /tipo de documento.*"CUIT" está deshabilitada/i);
    await page.locator("#idtipodocreceptor option").filter({ hasText: /^CUIT$/ }).evaluate((option) => {
      (option as HTMLOptionElement).disabled = false;
    });

    await page.locator("#nrodocreceptor").fill("12345678");
    await assert.rejects(() => captureRecipientEvidence(page, job), /número de documento.*valor inesperado/i);
    await page.locator("#nrodocreceptor").fill("");

    await page.locator("#razonsocialreceptor").fill("PERSONA FICTICIA");
    await assert.rejects(() => captureRecipientEvidence(page, job), /razón social.*valor inesperado/i);
    await page.locator("#razonsocialreceptor").fill("");

    await page.locator("#domicilioInput").fill("CALLE FICTICIA 100");
    await assert.rejects(() => captureRecipientEvidence(page, job), /Domicilio del Consumidor Final.*valor inesperado/i);
    await page.locator("#domicilioInput").fill("");

    await page.locator("#email").fill("persona@example.invalid");
    await assert.rejects(() => captureRecipientEvidence(page, job), /email.*valor inesperado/i);
    await page.locator("#email").fill("");

    for (const [name, label] of [
      ["cmpAsociadoPtoVta", "punto de venta"],
      ["cmpAsociadoNro", "número"],
      ["cmpAsociadoFechaEmision", "fecha de emisión"],
    ] as const) {
      const control = page.locator(`input[name='${name}']`);
      await control.fill("dato ficticio");
      await assert.rejects(() => captureRecipientEvidence(page, job), new RegExp(`${label}.*comprobante asociado.*valor inesperado`, "i"));
      await control.fill("");
    }

    await page.locator("#email").evaluate((input) => input.insertAdjacentHTML("afterend", '<input id="email" name="emailReceptor">'));
    await assert.rejects(() => captureRecipientEvidence(page, job), /email.*único control visible.*2/i);
    await page.locator("#email").last().evaluate((element) => element.remove());

    await page.locator("input[name='cmpAsociadoFechaEmision']").evaluate((element) => element.remove());
    await assert.rejects(() => captureRecipientEvidence(page, job), /fecha de emisión.*único control visible.*0/i);
    await page.locator("input[name='cmpAsociadoNro']").evaluate((element) => {
      element.insertAdjacentHTML("afterend", '<input name="cmpAsociadoFechaEmision">');
    });

    await page.locator("#idivareceptor").selectOption({ label: "IVA Responsable Inscripto" });
    await assert.rejects(() => captureRecipientEvidence(page, job), /no es exactamente Consumidor Final/i);

    await page.locator("#idivareceptor").evaluate((select) => {
      select.innerHTML = `
        <optgroup label="Condiciones no disponibles" disabled>
          <option value="5" selected>Consumidor Final</option>
        </optgroup>
        <option value="1">IVA Responsable Inscripto</option>
      `;
    });
    await assert.rejects(
      () => selectOptionContaining(page.locator("#idivareceptor"), "Consumidor Final"),
      /opción exacta y única.*deshabilitada.*habilitada/i,
    );
    await assert.rejects(
      () => captureRecipientEvidence(page, job),
      /opción exacta y única.*deshabilitada.*habilitada/i,
    );
  } finally {
    await browser.close();
  }
});

async function loadRcelFixture(page: import("playwright").Page, url: string, body: string): Promise<void> {
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
}
