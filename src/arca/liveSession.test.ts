import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ResolvedInvoiceJob } from "../types.js";
import { assertEmissionResultMatchesPdf, buildPreparedInvoiceSummary, classifyReadyState, invalidatesPreparation, missingExpectedSummarySignals } from "./liveSession.js";

function invoiceJob(): ResolvedInvoiceJob {
  return {
    schemaVersion: 2,
    operationId: "test-operation-live-001",
    issuerKey: "20000000001",
    recipientName: "Receptor de Prueba S.A.",
    recipientCuit: "20-00000000-1",
    recipientVatCondition: "IVA Responsable Inscripto",
    voucherType: "Factura C",
    pointOfSale: "00001",
    date: "2026-05-30",
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: "2026-05-01",
    billingPeriodTo: "2026-05-31",
    dueDate: "2026-06-05",
    saleCondition: "Otro",
    description: "Servicios de Consultoria",
    amount: 3000000,
    amountCents: 300000000,
    amountDecimal: "3000000.00",
    outputDir: path.resolve("artifacts/pdf/emisor-prueba/2026-05"),
  };
}

function completeSummaryBody(issuerCuit = "20000000001"): string {
  return `
    Representando a: 20000000001 - EMISOR TOTALMENTE FICTICIO
    Factura C
    Datos del Emisor
    Logo Preimpreso No
    Razón Social EMISOR TOTALMENTE FICTICIO
    Punto de Venta 00001
    Domicilio Avenida Ficción 100, CABA
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social RECEPTOR DE PRUEBA S.A.
    Domicilio Comercial Calle Ficticia 100, CABA
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
    Importe Total: $ 3.000.000,00
    Identidad alternativa no visible en el bloque: ${issuerCuit}
  `;
}

function completeControlEvidence() {
  return {
    issuer: "EMISOR TOTALMENTE FICTICIO",
    issuerCuit: "20000000001",
    issueDate: "30/05/2026",
    currency: "ARS" as const,
    billingPeriodFrom: "01/05/2026",
    billingPeriodTo: "31/05/2026",
    dueDate: "05/06/2026",
    recipientName: "RECEPTOR DE PRUEBA S.A.",
    recipientVatCondition: "IVA Responsable Inscripto",
    recipientCommercialAddress: "Calle Ficticia 100, CABA",
    description: "Servicios de Consultoría",
    amount: "3000000.00",
  };
}

test("prepare-invoice invalida cualquier preparación anterior antes de comenzar", () => {
  assert.equal(invalidatesPreparation("prepare-invoice"), true);
  assert.equal(invalidatesPreparation("status"), false);
  assert.equal(invalidatesPreparation("snapshot"), false);
  assert.equal(invalidatesPreparation("screenshot"), false);
  assert.equal(invalidatesPreparation("emit-prepared-invoice"), false);
  assert.equal(invalidatesPreparation("revalidate-prepared-invoice"), false);
});

test("el resultado visible y el PDF deben coincidir en número y CAE", () => {
  const pdf = { voucherNumber: "00001-00000042", cae: "99999999999999", pageCount: 1 };
  assert.doesNotThrow(() => assertEmissionResultMatchesPdf({
    voucherNumber: pdf.voucherNumber,
    cae: pdf.cae,
    bodyText: "Comprobante generado",
  }, pdf));
  assert.throws(() => assertEmissionResultMatchesPdf({ ...pdf, voucherNumber: `00001-${"00000043"}`, bodyText: "" }, pdf), /número.*no coincide/i);
  assert.throws(() => assertEmissionResultMatchesPdf({ ...pdf, cae: `${"1111111"}${"1111111"}`, bodyText: "" }, pdf), /CAE.*no coincide/i);
});

test("buildPreparedInvoiceSummary conserva identidad real del emisor sin fallback de credencial", () => {
  const summary = buildPreparedInvoiceSummary(
    completeSummaryBody(),
    invoiceJob(),
    completeControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );

  assert.equal(summary.issuer, "EMISOR TOTALMENTE FICTICIO");
  assert.equal(summary.issuerCuit, "20000000001");
  assert.equal(summary.issuerCommercialAddress, "Avenida Ficción 100, CABA");
  assert.equal(summary.rawContainsExpected, true);
});

test("buildPreparedInvoiceSummary no acepta que un CUIT global o receptor sustituya al control Representando a", () => {
  assert.throws(() => buildPreparedInvoiceSummary(
    completeSummaryBody("20000000001"),
    invoiceJob(),
    { ...completeControlEvidence(), issuerCuit: "27000000006" },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /CUIT del emisor representado no coincide/i);
});

test("buildPreparedInvoiceSummary falla sin evidencia del control o si discrepa la razón social", () => {
  assert.throws(() => buildPreparedInvoiceSummary(
    completeSummaryBody(),
    invoiceJob(),
    { ...completeControlEvidence(), issuer: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /No existe evidencia del control visible/i);
  assert.throws(() => buildPreparedInvoiceSummary(
    completeSummaryBody(),
    invoiceJob(),
    { ...completeControlEvidence(), issuer: "OTRO EMISOR TOTALMENTE FICTICIO" },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /razón social.*no coincide/i);
});

test("missingExpectedSummarySignals accepts ARCA Otro/Otra wording", () => {
  const bodyText = `
    Factura C
    Punto de Venta 00001
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social Receptor de Prueba S.A.
    Domicilio Comercial Calle Ficticia 100, CABA
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
    Importe Total: $ 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), []);
});

test("missingExpectedSummarySignals reports missing expected values", () => {
  const bodyText = `
    Factura C
    Punto de Venta 00001
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social Receptor de Prueba S.A.
    Domicilio Comercial Calle Ficticia 100, CABA
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), ["3.000.000,00"]);
});

test("missingExpectedSummarySignals exige el domicilio comercial con equivalencia documentada de CABA", () => {
  const job = { ...invoiceJob(), recipientCommercialAddress: "Calle Ficticia 100 Piso 2 Dpto A, CABA" };
  const bodyText = `
    Factura C
    Punto de Venta 00001
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social Receptor de Prueba S.A.
    Domicilio Comercial Calle Ficticia 100 Piso:2 Dpto:A - Capital Federal, Ciudad de Buenos Aires
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
    Importe Total: $ 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, job), []);
});

test("missingExpectedSummarySignals rechaza un resumen con otro domicilio comercial", () => {
  const job = { ...invoiceJob(), recipientCommercialAddress: "Calle Ficticia 100, CABA" };
  const bodyText = `
    Factura C
    Punto de Venta 00001
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social Receptor de Prueba S.A.
    Domicilio Comercial Calle Distinta 900, CABA
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
    Importe Total: $ 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, job), ["Domicilio Comercial: Calle Ficticia 100, CABA"]);
});

test("missingExpectedSummarySignals exige que el resumen muestre algún domicilio aun si el job usó el único disponible", () => {
  const bodyText = `
    Factura C
    Punto de Venta 00001
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/05/2026 hasta: 31/05/2026
    Vto. para el Pago 05/06/2026
    Datos del Receptor
    CUIT 20000000001
    Razón Social Receptor de Prueba S.A.
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
    Importe Total: $ 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), ["Domicilio Comercial"]);
});

test("missingExpectedSummarySignals no confunde el concepto con la descripción", () => {
  const bodyText = completeSummaryBody().replace("Conceptos a Incluir Servicios", "Conceptos a Incluir Productos");
  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), ["Conceptos a Incluir: Servicios"]);
});

test("missingExpectedSummarySignals exige una única línea con cantidad y precio unitario", () => {
  const bodyText = completeSummaryBody().replace("1,00 unidades", "2,00 unidades");
  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), [
    "Ítem: Servicios de Consultoria; cantidad 1; precio unitario 3.000.000,00",
  ]);
});

test("missingExpectedSummarySignals rechaza dos filas que en conjunto podrían satisfacer el ítem", () => {
  const duplicated = completeSummaryBody().replace(
    "Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00",
    "Servicios de Consultoría 1,00 unidades 3.000.000,00\nServicios de Consultoría 1,00 unidades 3.000.000,00",
  );
  assert.deepEqual(missingExpectedSummarySignals(duplicated, invoiceJob()), [
    "Ítem: Servicios de Consultoria; cantidad 1; precio unitario 3.000.000,00",
  ]);
});

test("classifyReadyState exige origen y ruta oficiales para declarar portal", () => {
  assert.equal(classifyReadyState("https://portalcf.cloud.afip.gob.ar/portal/app/", "Portal", "Buscador"), "portal");
  assert.notEqual(classifyReadyState("http://portalcf.cloud.afip.gob.ar/portal/app/", "Portal", "Buscador"), "portal");
  assert.notEqual(classifyReadyState("https://ejemplo.invalid/?next=https://portalcf.cloud.afip.gob.ar/portal/app/", "Portal", "Portal de Clave Fiscal Buscador"), "portal");
});

test("classifyReadyState exige un origen oficial exacto para autenticación", () => {
  assert.equal(classifyReadyState("https://auth.afip.gob.ar/contribuyente_/login.xhtml", "ARCA", "Ingresar"), "auth");
  assert.equal(classifyReadyState("https://auth.arca.gob.ar/contribuyente_/login.xhtml", "ARCA", "Ingresar"), "auth");
  assert.notEqual(classifyReadyState("https://auth.afip.gob.ar.ejemplo.invalid/login", "ARCA", "Ingresar"), "auth");
});

test("classifyReadyState no confía en títulos o textos RCEL falsificados", () => {
  assert.equal(classifyReadyState("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp", "Sin título", ""), "rcel_menu");
  assert.notEqual(classifyReadyState("https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/menu_ppal.jsp", "RCEL - Comprobantes", "Generar Comprobantes"), "rcel_menu");
  assert.notEqual(classifyReadyState("https://ejemplo.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp", "RCEL", "RCEL - RÉGIMEN DE COMPROBANTES EN LÍNEA"), "rcel_menu");
  assert.notEqual(classifyReadyState("https://fe.afip.gob.ar/rcel/jsp/ruta-no-aprendida.do", "RCEL", "Generar Comprobantes"), "rcel_menu");
});
