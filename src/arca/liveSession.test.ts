import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ResolvedInvoiceJob } from "../types.js";
import { assertEmissionResultMatchesPdf, buildPreparedInvoiceSummary, classifyReadyState, invalidatesPreparation, missingExpectedSummarySignals, redactSessionStateForLog, requiresRcelMenuReturn, validatePreparedSummary } from "./liveSession.js";

type IdentifiedResolvedInvoiceJob = Exclude<ResolvedInvoiceJob, { recipientKind: "anonymous-final-consumer" }>;

function invoiceJob(): IdentifiedResolvedInvoiceJob {
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
    Email
    Comprobantes Asociados -
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
    recipientKind: "identified-cuit" as const,
    recipientCuit: "20000000001",
    recipientName: "RECEPTOR DE PRUEBA S.A.",
    recipientVatCondition: "IVA Responsable Inscripto",
    recipientCommercialAddress: "Calle Ficticia 100, CABA",
    recipientEmailBlank: true as const,
    recipientAssociatedVoucherAbsent: true as const,
    description: "Servicios de Consultoría",
    amount: "3000000.00",
    quantity: "1",
    unitPrice: "3000000.00",
    subtotal: "3000000.00",
    total: "3000000.00",
  };
}

function anonymousInvoiceJob(): Extract<ResolvedInvoiceJob, { recipientKind: "anonymous-final-consumer" }> {
  return {
    schemaVersion: 2,
    operationId: "test-operation-anonymous-001",
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
    description: "Servicio profesional totalmente ficticio",
    amount: 123_456.78,
    amountCents: 12_345_678,
    amountDecimal: "123456.78",
    outputDir: path.resolve("artifacts/pdf/emisor-prueba/2030-06"),
  };
}

function anonymousSummaryBody(recipientRows = "Razón Social\nDomicilio Comercial"): string {
  return `
    Representando a: 20000000001 - EMISOR TOTALMENTE FICTICIO
    Factura C
    Datos del Emisor
    Logo Preimpreso No
    Razón Social EMISOR TOTALMENTE FICTICIO
    Punto de Venta 00009
    Domicilio Avenida Ficción 100, CABA
    Conceptos a Incluir Servicios
    Período Facturado desde: 01/06/2030 hasta: 30/06/2030
    Vto. para el Pago 20/06/2030
    Datos del Receptor
    ${recipientRows}
    Email
    Comprobantes Asociados -
    Condición frente al IVA Consumidor Final
    Condiciones de Venta Transferencia Bancaria
    Detalle de la Operación
    Servicio profesional totalmente ficticio 1,00 123.456,78 0,00 0,00 123.456,78
    Importe Total: $ 123.456,78
  `;
}

function anonymousControlEvidence() {
  return {
    issuer: "EMISOR TOTALMENTE FICTICIO",
    issuerCuit: "20000000001",
    issueDate: "15/06/2030",
    currency: "ARS" as const,
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    dueDate: "20/06/2030",
    recipientKind: "anonymous-final-consumer" as const,
    recipientDocumentTypeDefault: "CUIT" as const,
    recipientDocumentNumberBlank: true as const,
    recipientNameBlank: true as const,
    recipientCommercialAddressBlank: true as const,
    recipientEmailBlank: true as const,
    recipientAssociatedVoucherAbsent: true as const,
    recipientVatCondition: "Consumidor Final",
    description: "Servicio profesional totalmente ficticio",
    amount: "123456.78",
    quantity: "1",
    unitPrice: "123456.78",
    subtotal: "123456.78",
    total: "123456.78",
  };
}

test("prepare-invoice invalida cualquier preparación anterior antes de comenzar", () => {
  assert.equal(invalidatesPreparation("prepare-invoice"), true);
  assert.equal(invalidatesPreparation("status"), false);
  assert.equal(invalidatesPreparation("snapshot"), false);
  assert.equal(invalidatesPreparation("screenshot"), false);
  assert.equal(invalidatesPreparation("resume-authentication"), true);
  assert.equal(invalidatesPreparation("emit-prepared-invoice"), false);
  assert.equal(invalidatesPreparation("revalidate-prepared-invoice"), false);
});

test("el log de sesión omite CUIT, URL y rutas privadas", () => {
  const redacted = redactSessionStateForLog({
    issuerKey: "20000000001",
    url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml",
    title: "Portal",
    readyState: "portal",
    captchaVisible: false,
    pageCount: 1,
    artifactDir: path.resolve("runtime-ficticio", "artifacts"),
    visibilityMode: "visible",
    revalidationCapability: "invoice-services-single-item",
    revalidationConsumed: false,
  });
  assert.deepEqual(redacted, {
    readyState: "portal",
    captchaVisible: false,
    pageCount: 1,
    visibilityMode: "visible",
    learnedCapability: undefined,
    revalidationCapability: "invoice-services-single-item",
    revalidationConsumed: false,
  });
  assert.equal("issuerKey" in redacted, false);
  assert.equal("url" in redacted, false);
  assert.equal("artifactDir" in redacted, false);
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

test("validatePreparedSummary compara las fechas ISO del job con el formato visible de ARCA", () => {
  const job = invoiceJob();
  const summary = buildPreparedInvoiceSummary(
    completeSummaryBody(),
    job,
    completeControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );

  assert.doesNotThrow(() => validatePreparedSummary(summary, job));
  assert.throws(
    () => validatePreparedSummary({ ...summary, billingPeriodTo: "30/05/2026" }, job),
    /período hasta/i,
  );
  assert.throws(
    () => validatePreparedSummary({ ...summary, dueDate: "06/06/2026" }, job),
    /vencimiento/i,
  );
});

test("el resumen acepta puntuación societaria equivalente y bloquea un tipo societario distinto", () => {
  const job = invoiceJob();
  const bodyWithSa = completeSummaryBody().replace("RECEPTOR DE PRUEBA S.A.", "RECEPTOR DE PRUEBA SA");
  const summaryWithSa = buildPreparedInvoiceSummary(
    bodyWithSa,
    job,
    { ...completeControlEvidence(), recipientName: "RECEPTOR DE PRUEBA SA" },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );
  assert.doesNotThrow(() => validatePreparedSummary(summaryWithSa, job));

  const bodyWithSrl = completeSummaryBody().replace("RECEPTOR DE PRUEBA S.A.", "RECEPTOR DE PRUEBA SRL");
  assert.throws(() => buildPreparedInvoiceSummary(
    bodyWithSrl,
    job,
    { ...completeControlEvidence(), recipientName: "RECEPTOR DE PRUEBA SRL" },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /identidad visible del receptor no coincide/i);
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

test("buildPreparedInvoiceSummary bloquea un CUIT de receptor ausente o alterado en la evidencia", () => {
  assert.throws(() => buildPreparedInvoiceSummary(
    completeSummaryBody(),
    invoiceJob(),
    { ...completeControlEvidence(), recipientCuit: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /identidad del receptor/i);
  assert.throws(() => buildPreparedInvoiceSummary(
    completeSummaryBody(),
    invoiceJob(),
    { ...completeControlEvidence(), recipientCuit: "20000000002" },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /identidad visible del receptor no coincide/i);
});

test("el resumen acepta Consumidor Final anónimo solo con CUIT predeterminado y datos identificatorios vacíos", () => {
  const job = anonymousInvoiceJob();
  const summary = buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    anonymousControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );

  assert.equal(summary.recipientKind, "anonymous-final-consumer");
  assert.equal(summary.recipientVatCondition, "Consumidor Final");
  assert.equal(summary.recipientCuit, undefined);
  assert.equal(summary.recipientName, undefined);
  assert.equal(summary.recipientCommercialAddress, undefined);
  assert.equal(summary.recipientEmailBlank, true);
  assert.equal(summary.recipientAssociatedVoucherAbsent, true);
  assert.doesNotThrow(() => validatePreparedSummary(summary, job));

  assert.throws(() => buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    { ...anonymousControlEvidence(), recipientDocumentTypeDefault: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /evidencia visible positiva/i);
  assert.throws(() => buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    { ...anonymousControlEvidence(), recipientNameBlank: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /evidencia visible positiva/i);
  assert.throws(() => buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    { ...anonymousControlEvidence(), recipientEmailBlank: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /Email vacío.*Comprobantes Asociados ausentes/i);
  assert.throws(() => buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    { ...anonymousControlEvidence(), recipientAssociatedVoucherAbsent: undefined },
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  ), /Email vacío.*Comprobantes Asociados ausentes/i);
});

test("ambos tipos de receptor exigen evidencia positiva de opcionales ausentes", () => {
  const identifiedJob = invoiceJob();
  for (const missingField of ["recipientEmailBlank", "recipientAssociatedVoucherAbsent"] as const) {
    assert.throws(() => buildPreparedInvoiceSummary(
      completeSummaryBody(),
      identifiedJob,
      { ...completeControlEvidence(), [missingField]: undefined },
      { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
    ), /Email vacío.*Comprobantes Asociados ausentes/i);
  }

  const summary = buildPreparedInvoiceSummary(
    completeSummaryBody(),
    identifiedJob,
    completeControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );
  assert.equal(summary.recipientEmailBlank, true);
  assert.equal(summary.recipientAssociatedVoucherAbsent, true);
  assert.throws(
    () => validatePreparedSummary({ ...summary, recipientEmailBlank: undefined }, identifiedJob),
    /email ausente/i,
  );
  assert.throws(
    () => validatePreparedSummary({ ...summary, recipientAssociatedVoucherAbsent: undefined }, identifiedJob),
    /comprobantes asociados ausentes/i,
  );
});

test("el resumen exige Email vacío y Comprobantes Asociados exactamente '-' para ambos receptores", () => {
  for (const [body, job] of [
    [completeSummaryBody(), invoiceJob()],
    [anonymousSummaryBody(), anonymousInvoiceJob()],
  ] as const) {
    assert.deepEqual(missingExpectedSummarySignals(body, job), []);
    for (const [from, to, expected] of [
      ["Email", "Email correo@example.invalid", ["Email del receptor vacío"]],
      ["Email", "Email\nEmail", ["Email del receptor vacío"]],
      ["Email\n", "", ["Email del receptor vacío"]],
      ["Comprobantes Asociados -", "Comprobantes Asociados", ["Comprobantes Asociados: -"]],
      ["Comprobantes Asociados -", "Comprobantes Asociados 00001-00000042", ["Comprobantes Asociados: -"]],
      ["Comprobantes Asociados -", "Comprobantes Asociados -\nComprobantes Asociados -", ["Comprobantes Asociados: -"]],
    ] as const) {
      assert.deepEqual(missingExpectedSummarySignals(body.replace(from, to), job), expected);
    }
  }

  assert.deepEqual(
    missingExpectedSummarySignals(anonymousSummaryBody().replace("Email", "Etiqueta optativa nueva"), anonymousInvoiceJob()),
    ["Bloque del receptor anónimo sin filas inesperadas", "Email del receptor vacío"],
  );

  const invalidEmailSummary = buildPreparedInvoiceSummary(
    completeSummaryBody().replace("Email", "Email correo@example.invalid"),
    invoiceJob(),
    completeControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );
  assert.equal(invalidEmailSummary.recipientEmailBlank, undefined);
  assert.equal(invalidEmailSummary.recipientAssociatedVoucherAbsent, true);
  assert.equal(invalidEmailSummary.rawContainsExpected, false);

  const invalidAssociatedSummary = buildPreparedInvoiceSummary(
    anonymousSummaryBody().replace("Comprobantes Asociados -", "Comprobantes Asociados"),
    anonymousInvoiceJob(),
    anonymousControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );
  assert.equal(invalidAssociatedSummary.recipientEmailBlank, true);
  assert.equal(invalidAssociatedSummary.recipientAssociatedVoucherAbsent, undefined);
  assert.equal(invalidAssociatedSummary.rawContainsExpected, false);
});

test("el resumen anónimo bloquea cualquier identidad escrita, duplicación o alteración posterior", () => {
  const job = anonymousInvoiceJob();
  assert.deepEqual(
    missingExpectedSummarySignals(anonymousSummaryBody("Razón Social PERSONA FICTICIA\nDomicilio Comercial"), job),
    ["Razón Social del receptor vacía"],
  );
  assert.deepEqual(
    missingExpectedSummarySignals(anonymousSummaryBody("CUIT 20000000001\nRazón Social\nDomicilio Comercial"), job),
    ["CUIT del receptor vacío"],
  );
  assert.deepEqual(
    missingExpectedSummarySignals(anonymousSummaryBody("Razón Social\nRazón Social\nDomicilio Comercial"), job),
    ["Razón Social del receptor vacía"],
  );

  const summary = buildPreparedInvoiceSummary(
    anonymousSummaryBody(),
    job,
    anonymousControlEvidence(),
    { sessionIssuerKey: "20000000001", credentialCuit: "20000000001" },
  );
  assert.throws(
    () => validatePreparedSummary({ ...summary, recipientCuit: "20000000001" }, job),
    /identificación ausente/i,
  );
});

test("el resumen anónimo admite omitir CUIT o mostrar su fila vacía y bloquea cualquier otra fila documental", () => {
  const job = anonymousInvoiceJob();
  assert.deepEqual(missingExpectedSummarySignals(anonymousSummaryBody(), job), []);
  assert.deepEqual(
    missingExpectedSummarySignals(anonymousSummaryBody("CUIT\nRazón Social\nDomicilio Comercial"), job),
    [],
  );

  for (const unexpectedRow of [
    "CUIL 20-00000000-1",
    "CDI 20-00000000-1",
    "DNI 12.345.678",
    "L.E. 12.345.678",
    "L.C. 12.345.678",
    "Pasaporte ABC123456",
    "CI Extranjera 12345678",
    "Certificado de Migración 12345678",
    "Tipo y Nro. de Documento CUIT 20-00000000-1",
    "Tipo de Documento CUIT",
    "Número de Documento 12345678",
    "Doc. 12.345.678",
    "Identificación 20-00000000-1",
    "Etiqueta nueva 12345678",
    "12345678",
  ]) {
    assert.deepEqual(
      missingExpectedSummarySignals(anonymousSummaryBody(`${unexpectedRow}\nRazón Social\nDomicilio Comercial`), job),
      ["Bloque del receptor anónimo sin filas inesperadas"],
      unexpectedRow,
    );
  }
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
    Email
    Comprobantes Asociados -
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
    Email
    Comprobantes Asociados -
    Condición frente al IVA IVA Responsable Inscripto
    Condiciones de Venta Otra
    Detalle de la Operación
    Servicios de Consultoría 1,00 unidades 3.000.000,00 0,00 0,00 3.000.000,00
  `;

  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), ["3.000.000,00"]);
});

test("missingExpectedSummarySignals bloquea campos de identidad duplicados", () => {
  const duplicateRecipientName = completeSummaryBody().replace(
    "Razón Social RECEPTOR DE PRUEBA S.A.",
    "Razón Social RECEPTOR DE PRUEBA S.A.\nRazón Social RECEPTOR DE PRUEBA S.A.",
  );
  assert.deepEqual(missingExpectedSummarySignals(duplicateRecipientName, invoiceJob()), ["Razón social del receptor"]);

  const duplicateRecipientCuit = completeSummaryBody().replace(
    "CUIT 20000000001",
    "CUIT 20000000001\nCUIT 20000000001",
  );
  assert.deepEqual(missingExpectedSummarySignals(duplicateRecipientCuit, invoiceJob()), ["CUIT del receptor"]);
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
    Email
    Comprobantes Asociados -
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
    Email
    Comprobantes Asociados -
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
    Email
    Comprobantes Asociados -
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

test("missingExpectedSummarySignals acepta la grafía Incluír que muestra ARCA", () => {
  const bodyText = completeSummaryBody().replace("Conceptos a Incluir Servicios", "Conceptos a Incluír Servicios");
  assert.deepEqual(missingExpectedSummarySignals(bodyText, invoiceJob()), []);
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

test("una factura nueva vuelve al menú RCEL desde el comprobante generado", () => {
  assert.equal(requiresRcelMenuReturn("Comprobante Generado\nImprimir...\nMenú Principal"), true);
  assert.equal(requiresRcelMenuReturn("Generar Comprobantes"), false);
});
