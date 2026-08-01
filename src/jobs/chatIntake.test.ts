import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationalInvoiceInput, parseConversationalInvoiceJson } from "./chatIntake.js";

test("normaliza fechas locales, importe argentino, CUIT y vencimiento predeterminado", () => {
  const normalized = normalizeConversationalInvoiceInput({
    intentId: "00000000-0000-4000-8000-000000000001",
    issuerSelector: "Emisor Ficticio",
    recipientCuit: "20-00000000-1",
    recipientName: "Receptor Ficticio",
    recipientVatCondition: "IVA Responsable Inscripto",
    pointOfSale: 1,
    date: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    dueDate: "Default",
    saleCondition: "Transferencia bancaria.",
    description: "Servicio técnico completamente ficticio",
    amount: "123.456,78",
  });
  assert.equal(normalized.recipientCuit, "20000000001");
  assert.equal(normalized.pointOfSale, "1");
  assert.equal(normalized.date, "2030-06-15");
  assert.equal(normalized.billingPeriodFrom, "2030-06-01");
  assert.equal(normalized.billingPeriodTo, "2030-06-30");
  assert.equal(normalized.dueDate, undefined);
  assert.equal(normalized.saleCondition, "Transferencia bancaria");
  assert.equal(normalized.amount, "123456.78");
  assert.equal(Object.hasOwn(normalized, "recipientKind"), false);
});

test("acepta Consumidor Final anónimo sin materializar identidad fiscal", () => {
  const normalized = normalizeConversationalInvoiceInput({
    intentId: "00000000-0000-4000-8000-000000000003",
    issuerSelector: "Emisor Ficticio",
    recipientKind: "anonymous-final-consumer",
    recipientVatCondition: "Consumidor Final",
    pointOfSale: 2,
    date: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    dueDate: "Default",
    saleCondition: "Transferencia bancaria.",
    description: "Servicio ficticio para prueba",
    amount: "100.000,00",
  });
  assert.equal(normalized.recipientKind, "anonymous-final-consumer");
  assert.equal(normalized.recipientVatCondition, "Consumidor Final");
  assert.equal(Object.hasOwn(normalized, "recipientCuit"), false);
  assert.equal(Object.hasOwn(normalized, "recipientName"), false);
  assert.equal(Object.hasOwn(normalized, "recipientCommercialAddress"), false);
  assert.equal(normalized.amount, "100000.00");
});

test("rechaza identidad o condición IVA incompatibles con receptor anónimo", () => {
  const anonymous = {
    intentId: "00000000-0000-4000-8000-000000000003",
    issuerSelector: "Emisor Ficticio",
    recipientKind: "anonymous-final-consumer",
    recipientVatCondition: "Consumidor Final",
    pointOfSale: 2,
    date: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    saleCondition: "Transferencia bancaria",
    description: "Servicio ficticio para prueba",
    amount: "100000.00",
  };
  assert.equal(normalizeConversationalInvoiceInput(anonymous).recipientKind, "anonymous-final-consumer");
  assert.throws(() => normalizeConversationalInvoiceInput({ ...anonymous, recipientVatCondition: "IVA Responsable Inscripto" }));
  assert.throws(() => normalizeConversationalInvoiceInput({ ...anonymous, recipientCuit: "20-00000000-1" }));
  assert.throws(() => normalizeConversationalInvoiceInput({ ...anonymous, recipientName: "RECEPTOR FICTICIO" }));
  assert.throws(() => normalizeConversationalInvoiceInput({ ...anonymous, recipientCommercialAddress: "DOMICILIO FICTICIO 123" }));
});

test("rechaza fechas inexistentes e importes ambiguos antes de abrir Chrome", () => {
  const base = {
    intentId: "00000000-0000-4000-8000-000000000001",
    issuerSelector: "Emisor Ficticio",
    recipientCuit: "20000000001",
    recipientVatCondition: "IVA Responsable Inscripto",
    pointOfSale: "1",
    date: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    saleCondition: "Transferencia bancaria",
    description: "Servicio ficticio",
    amount: "100,00",
  };
  assert.throws(() => normalizeConversationalInvoiceInput({ ...base, date: "31/02/2030" }), /no existe/);
  assert.throws(() => normalizeConversationalInvoiceInput({ ...base, amount: "100" }), /dos decimales/);
  assert.throws(() => normalizeConversationalInvoiceInput({ ...base, amount: 100.129 }), /redondeo/);
  assert.equal(normalizeConversationalInvoiceInput({ ...base, amount: 100.12 }).amount, "100.12");
});

test("un JSON inválido nunca refleja su contenido fiscal en el error", () => {
  const sentinel = ["dato", "fiscal", "privado"].join("-");
  assert.throws(() => parseConversationalInvoiceJson(`{"issuerSelector":"${sentinel}"`), (error: Error) => {
    assert.match(error.message, /JSON válido/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    return true;
  });
});
