import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { fillInvoice } from "./invoice.js";
import { ResolvedInvoiceJob } from "../types.js";

test("la ruta rápida espera cada pantalla y el total calculado sin networkidle ni pausas fijas", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const fixture = `
      <main>
        <p>Representando a: 20000000001 - EMISOR TOTALMENTE FICTICIO</p>
        <section id="menu"><button id="generar">Generar Comprobantes</button></section>
        <section id="inicial" hidden>
          <label>Punto de Venta <select id="puntodeventa" name="puntodeventa"><option value="">seleccionar...</option><option value="1">00001-Domicilio</option></select></label>
          <label>Tipo de Comprobante <select id="universocomprobante" name="universoComprobante"><option value="">seleccionar...</option></select></label>
          <button id="continuar-inicial">Continuar</button>
        </section>
        <section id="emision" hidden>
          <label>Fecha del Comprobante <input name="fechaComprobante"></label>
          <label>Conceptos a incluir <select id="idconcepto" name="idConcepto"><option value="2">Servicios</option></select></label>
          <label><input id="monedaExtranjera" name="monedaExtranjera" type="checkbox"> Moneda Extranjera</label>
          <label>Desde <input name="periodoDesde"></label>
          <label>Hasta <input name="periodoHasta"></label>
          <label>Vto. para el Pago <input name="fechaVencimiento"></label>
          <label>Actividad <select id="actividad" name="actividad"><option value="-1">seleccionar...</option></select></label>
          <button id="continuar-emision">Continuar</button>
        </section>
        <section id="receptor" hidden>
          <label>Condición frente al IVA <select id="idivareceptor"><option value="5">IVA Sujeto Exento</option></select></label>
          <label>Tipo y Nro. de Documento <select id="idtipodocreceptor" name="tipoDoc"><option value="80">CUIT</option></select></label>
          <label>CUIT <input id="nrodocreceptor"></label>
          <label>Razón Social <input id="razonsocialreceptor" readonly></label>
          <label>Domicilio Comercial <select id="domicilioreceptor" name="domicilioReceptor"><option value="">seleccionar...</option></select></label>
          <label>Email <input id="email" name="emailReceptor"></label>
          <label>Tipo de comprobante asociado <select name="cmp_asoc_tipo"><option value="91" selected>Remito R</option></select></label>
          <label>Punto de venta asociado <input name="cmpAsociadoPtoVta"></label>
          <label>Número asociado <input name="cmpAsociadoNro"></label>
          <label>Fecha asociada <input name="cmpAsociadoFechaEmision"></label>
          <label><input type="checkbox"> Transferencia Bancaria</label>
          <button id="continuar-receptor">Continuar</button>
        </section>
        <section id="operacion" hidden>
          <label>Producto/Servicio <input id="detalle_descripcion1" name="detalle_descripcion1"></label>
          <label>Cant. <input id="detalle_cantidad1" name="detalle_cantidad1"></label>
          <label>U. Medida <select id="detalle_medida1" name="detalle_medida1"><option value="">seleccionar...</option></select></label>
          <label>Precio Unitario <input id="detalle_precio1" name="detalle_precio1"></label>
          <table>
            <tr><td>Subtotal: $</td><td><input id="subtotal" readonly></td></tr>
            <tr><td>Importe Total: $</td><td><input id="importeTotal" readonly></td></tr>
          </table>
          <button id="continuar-operacion">Continuar</button>
        </section>
        <section id="resumen" hidden><h1>RESUMEN DE DATOS (PASO 4 DE 4)</h1><button>Confirmar Datos...</button></section>
      </main>
      <script>
        const show = (current, next, path) => {
          document.querySelector(current).hidden = true;
          document.querySelector(next).hidden = false;
          history.pushState({}, '', path);
        };
        document.querySelector('#generar').addEventListener('click', () => show('#menu', '#inicial', '/rcel/jsp/buscarPtosVtas'));
        document.querySelector('#puntodeventa').addEventListener('change', () => setTimeout(() => {
          document.querySelector('#universocomprobante').insertAdjacentHTML('beforeend', '<option value="11">Factura C</option>');
        }, 40));
        document.querySelector('#continuar-inicial').addEventListener('click', () => show('#inicial', '#emision', '/rcel/jsp/genComDatosEmisor.do'));
        document.querySelector('#continuar-emision').addEventListener('click', () => show('#emision', '#receptor', '/rcel/jsp/genComDatosReceptor.do'));
        document.querySelector('#nrodocreceptor').addEventListener('blur', () => setTimeout(() => {
          document.querySelector('#razonsocialreceptor').value = 'ENTIDAD FICTICIA DE PRUEBA';
          document.querySelector('#domicilioreceptor').insertAdjacentHTML('beforeend', '<option value="1">Avenida Ejemplo 100</option>');
        }, 40));
        document.querySelector('[name="cmp_asoc_tipo"]').addEventListener('change', () => { document.body.dataset.associatedVoucherTypeChanged = '1'; });
        document.querySelector('#continuar-receptor').addEventListener('click', () => show('#receptor', '#operacion', '/rcel/jsp/genComDatosOperacion.do'));
        document.querySelector('#detalle_precio1').addEventListener('blur', () => setTimeout(() => {
          document.querySelector('#subtotal').value = document.querySelector('#detalle_precio1').value;
          document.querySelector('#importeTotal').value = document.querySelector('#detalle_precio1').value;
        }, 40));
        document.querySelector('#continuar-operacion').addEventListener('click', () => show('#operacion', '#resumen', '/rcel/jsp/genComResumenDatos.do'));
      </script>
    `;
    await page.route("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp");

    const observedLoadStates: string[] = [];
    const observedWaitDurations: number[] = [];
    const originalWaitForLoadState = page.waitForLoadState.bind(page);
    const originalWaitForTimeout = page.waitForTimeout.bind(page);
    page.waitForLoadState = async (state = "load", options) => {
      observedLoadStates.push(state);
      await originalWaitForLoadState(state, options);
    };
    page.waitForTimeout = async (timeout) => {
      observedWaitDurations.push(timeout);
      await originalWaitForTimeout(timeout);
    };

    const job = {
      schemaVersion: 2,
      operationId: "integration-fast-path-001",
      issuerKey: "20000000001",
      recipientCuit: "20000000001",
      recipientName: "ENTIDAD FICTICIA DE PRUEBA",
      recipientVatCondition: "IVA Sujeto Exento",
      recipientCommercialAddress: "Avenida Ejemplo 100",
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
      amount: 123456.78,
      amountCents: 12_345_678,
      amountDecimal: "123456.78",
      outputDir: "C:\\runtime\\downloads",
    } satisfies ResolvedInvoiceJob;

    const evidence = await fillInvoice(page, job, { strictSelectors: true, interactive: false, manualIntervention: false });
    assert.equal(await page.locator("#resumen").isVisible(), true);
    assert.equal(evidence.amount, "123456.78");
    assert.equal(evidence.currency, "ARS");
    assert.equal(evidence.issuerCuit, "20000000001");
    assert.equal(evidence.issuer, "EMISOR TOTALMENTE FICTICIO");
    assert.equal(evidence.recipientCuit, "20000000001");
    assert.equal(evidence.recipientName, "ENTIDAD FICTICIA DE PRUEBA");
    assert.equal(evidence.recipientEmailBlank, true);
    assert.equal(evidence.recipientAssociatedVoucherAbsent, true);
    assert.equal(await page.locator("[name='cmp_asoc_tipo'] option:checked").textContent(), "Remito R");
    assert.equal(await page.locator("body").getAttribute("data-associated-voucher-type-changed"), null);
    assert.equal(observedLoadStates.includes("networkidle"), false);
    assert.equal(observedWaitDurations.every((duration) => duration <= 100), true);
  } finally {
    await browser.close();
  }
});

test("el Consumidor Final anónimo llega al resumen sin identificar ni autocompletar al receptor", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const fixture = `
      <main>
        <p>Representando a: 20000000001 - EMISOR TOTALMENTE FICTICIO</p>
        <section id="menu"><button id="generar">Generar Comprobantes</button></section>
        <section id="inicial" hidden>
          <label>Punto de Venta <select id="puntodeventa" name="puntodeventa"><option value="">seleccionar...</option><option value="9">00009-Domicilio ficticio</option></select></label>
          <label>Tipo de Comprobante <select id="universocomprobante" name="universoComprobante"><option value="">seleccionar...</option></select></label>
          <button id="continuar-inicial">Continuar</button>
        </section>
        <section id="emision" hidden>
          <label>Fecha del Comprobante <input name="fechaComprobante"></label>
          <label>Conceptos a incluir <select id="idconcepto" name="idConcepto"><option value="2">Servicios</option></select></label>
          <label><input id="monedaExtranjera" name="monedaExtranjera" type="checkbox"> Moneda Extranjera</label>
          <label>Desde <input name="periodoDesde"></label>
          <label>Hasta <input name="periodoHasta"></label>
          <label>Vto. para el Pago <input name="fechaVencimiento"></label>
          <label>Actividad <select id="actividad" name="actividad"><option value="-1">seleccionar...</option></select></label>
          <button id="continuar-emision">Continuar</button>
        </section>
        <section id="receptor" hidden>
          <label>Condición frente al IVA
            <select id="idivareceptor" name="ivaReceptor">
              <option value="">seleccionar...</option>
              <option value="5">Consumidor Final</option>
            </select>
          </label>
          <label>Tipo y Nro. de Documento
            <select id="idtipodocreceptor" name="tipoDoc">
              <option value="96">DNI</option>
              <option value="80" selected>CUIT</option>
            </select>
          </label>
          <label>Número <input id="nrodocreceptor"></label>
          <label>Razón Social <input id="razonsocialreceptor"></label>
          <label>Domicilio Comercial <input id="domicilioInput" name="domicilioReceptor"></label>
          <label>Email <input id="email" name="emailReceptor"></label>
          <label>Tipo de comprobante asociado
            <select name="cmp_asoc_tipo"><option value="91" selected>Remito R</option></select>
          </label>
          <label>Punto de venta asociado <input name="cmpAsociadoPtoVta"></label>
          <label>Número asociado <input name="cmpAsociadoNro"></label>
          <label>Fecha asociada <input name="cmpAsociadoFechaEmision"></label>
          <label><input id="transferencia" type="checkbox"> Transferencia Bancaria</label>
          <button id="continuar-receptor">Continuar</button>
        </section>
        <section id="operacion" hidden>
          <label>Producto/Servicio <input id="detalle_descripcion1" name="detalle_descripcion1"></label>
          <label>Cant. <input id="detalle_cantidad1" name="detalle_cantidad1"></label>
          <label>U. Medida <select id="detalle_medida1" name="detalle_medida1"><option value="">seleccionar...</option></select></label>
          <label>Precio Unitario <input id="detalle_precio1" name="detalle_precio1"></label>
          <table>
            <tr><td>Subtotal: $</td><td><input id="subtotal" readonly></td></tr>
            <tr><td>Importe Total: $</td><td><input id="importeTotal" readonly></td></tr>
          </table>
          <button id="continuar-operacion">Continuar</button>
        </section>
        <section id="resumen" hidden><h1>RESUMEN DE DATOS (PASO 4 DE 4)</h1><button>Confirmar Datos...</button></section>
      </main>
      <script>
        const show = (current, next, path) => {
          document.querySelector(current).hidden = true;
          document.querySelector(next).hidden = false;
          history.pushState({}, '', path);
        };
        document.querySelector('#generar').addEventListener('click', () => show('#menu', '#inicial', '/rcel/jsp/buscarPtosVtas'));
        document.querySelector('#puntodeventa').addEventListener('change', () => setTimeout(() => {
          document.querySelector('#universocomprobante').insertAdjacentHTML('beforeend', '<option value="11">Factura C</option>');
        }, 40));
        document.querySelector('#continuar-inicial').addEventListener('click', () => show('#inicial', '#emision', '/rcel/jsp/genComDatosEmisor.do'));
        document.querySelector('#continuar-emision').addEventListener('click', () => show('#emision', '#receptor', '/rcel/jsp/genComDatosReceptor.do'));
        document.querySelector('#idivareceptor').addEventListener('change', () => {
          document.body.dataset.documentTypeAjaxStarted = '1';
          setTimeout(() => {
            document.querySelector('#idtipodocreceptor').innerHTML = '<option value="96">DNI</option><option value="80" selected>CUIT</option>';
            document.body.dataset.documentTypeAjaxFinished = '1';
          }, 250);
        });
        document.querySelector('#idtipodocreceptor').addEventListener('change', () => { document.body.dataset.documentTypeChanged = '1'; });
        document.querySelector('#nrodocreceptor').addEventListener('input', () => { document.body.dataset.documentNumberChanged = '1'; });
        document.querySelector('#email').addEventListener('input', () => { document.body.dataset.emailChanged = '1'; });
        document.querySelector('[name="cmp_asoc_tipo"]').addEventListener('change', () => { document.body.dataset.associatedVoucherTypeChanged = '1'; });
        for (const name of ['cmpAsociadoPtoVta', 'cmpAsociadoNro', 'cmpAsociadoFechaEmision']) {
          document.querySelector('[name="' + name + '"]').addEventListener('input', () => { document.body.dataset.associatedVoucherChanged = '1'; });
        }
        document.querySelector('#continuar-receptor').addEventListener('click', () => {
          if (document.body.dataset.documentTypeAjaxFinished !== '1') document.body.dataset.continuedBeforeDocumentTypeAjax = '1';
          show('#receptor', '#operacion', '/rcel/jsp/genComDatosOperacion.do');
        });
        document.querySelector('#detalle_precio1').addEventListener('blur', () => setTimeout(() => {
          document.querySelector('#subtotal').value = document.querySelector('#detalle_precio1').value;
          document.querySelector('#importeTotal').value = document.querySelector('#detalle_precio1').value;
        }, 40));
        document.querySelector('#continuar-operacion').addEventListener('click', () => show('#operacion', '#resumen', '/rcel/jsp/genComResumenDatos.do'));
      </script>
    `;
    await page.route("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp");

    const job = {
      schemaVersion: 2,
      operationId: "integration-anonymous-final-consumer-001",
      issuerKey: "20000000001",
      recipientKind: "anonymous-final-consumer",
      recipientVatCondition: "Consumidor Final",
      voucherType: "Factura C",
      pointOfSale: "00009",
      date: "2030-06-15",
      concept: "Servicios",
      currency: "ARS",
      billingPeriodFrom: "2030-06-01",
      billingPeriodTo: "2030-06-30",
      dueDate: "2030-06-20",
      saleCondition: "Transferencia Bancaria",
      description: "Servicio profesional ficticio",
      amount: 123_456.78,
      amountCents: 12_345_678,
      amountDecimal: "123456.78",
      outputDir: "C:\\runtime\\downloads",
    } satisfies ResolvedInvoiceJob;

    const evidence = await fillInvoice(page, job, { strictSelectors: true, interactive: false, manualIntervention: false });

    assert.equal(await page.locator("#resumen").isVisible(), true);
    assert.equal(evidence.recipientKind, "anonymous-final-consumer");
    assert.equal(evidence.recipientVatCondition, "Consumidor Final");
    assert.equal(evidence.recipientDocumentTypeDefault, "CUIT");
    assert.equal(evidence.recipientDocumentNumberBlank, true);
    assert.equal(evidence.recipientNameBlank, true);
    assert.equal(evidence.recipientCommercialAddressBlank, true);
    assert.equal(evidence.recipientEmailBlank, true);
    assert.equal(evidence.recipientAssociatedVoucherAbsent, true);
    assert.equal("recipientCuit" in evidence, false);
    assert.equal("recipientName" in evidence, false);
    assert.equal("recipientCommercialAddress" in evidence, false);
    assert.equal(((await page.locator("#idtipodocreceptor option:checked").textContent()) ?? "").trim(), "CUIT");
    assert.equal(await page.locator("#idtipodocreceptor option:checked").isEnabled(), true);
    assert.equal(await page.locator("#nrodocreceptor").inputValue(), "");
    assert.equal(await page.locator("#razonsocialreceptor").inputValue(), "");
    assert.equal(await page.locator("#domicilioInput").inputValue(), "");
    assert.equal(await page.locator("#email").inputValue(), "");
    assert.equal(await page.locator("input[name='cmpAsociadoPtoVta']").inputValue(), "");
    assert.equal(await page.locator("input[name='cmpAsociadoNro']").inputValue(), "");
    assert.equal(await page.locator("input[name='cmpAsociadoFechaEmision']").inputValue(), "");
    assert.equal(await page.locator("[name='cmp_asoc_tipo'] option:checked").textContent(), "Remito R");
    assert.equal(await page.locator("body").getAttribute("data-document-type-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-document-number-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-email-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-associated-voucher-type-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-associated-voucher-changed"), null);
    assert.equal(await page.locator("body").getAttribute("data-document-type-ajax-started"), "1");
    assert.equal(await page.locator("body").getAttribute("data-document-type-ajax-finished"), "1");
    assert.equal(await page.locator("body").getAttribute("data-continued-before-document-type-ajax"), null);
  } finally {
    await browser.close();
  }
});

test("fillInvoice no lee ni muta un formulario fiscal con origen engañoso", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const deceptiveUrl = "https://ejemplo.invalid/forged?next=https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp";
    await page.route(deceptiveUrl, (route) => route.fulfill({
      contentType: "text/html",
      body: `<title>RCEL</title><button onclick="document.body.dataset.clicked='1'">Generar Comprobantes</button>`,
    }));
    await page.goto(deceptiveUrl);

    await assert.rejects(
      () => fillInvoice(page, {} as ResolvedInvoiceJob, { strictSelectors: true, interactive: false, manualIntervention: false }),
      /ARCA_UNTRUSTED_RCEL_PAGE/,
    );
    assert.equal(await page.evaluate(() => document.body.dataset.clicked ?? ""), "");
  } finally {
    await browser.close();
  }
});
