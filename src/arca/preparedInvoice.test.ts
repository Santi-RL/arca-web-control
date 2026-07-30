import assert from "node:assert/strict";
import test from "node:test";
import { PreparedInvoiceStore, PreparedInvoiceSummary } from "./preparedInvoice.js";
import { ResolvedInvoiceJob } from "../types.js";

const job: ResolvedInvoiceJob = {
  schemaVersion: 2,
  operationId: "test-operation-001",
  issuerKey: "20000000001",
  recipientCuit: "20000000001",
  recipientVatCondition: "Consumidor Final",
  voucherType: "Factura C",
  pointOfSale: "00001",
  date: "2030-06-15",
  concept: "Servicios",
  currency: "ARS",
  billingPeriodFrom: "2030-06-01",
  billingPeriodTo: "2030-06-30",
  dueDate: "2030-07-10",
  saleCondition: "Otra",
  description: "Prueba",
  amount: 100,
  amountCents: 10000,
  amountDecimal: "100.00",
  outputDir: "C:\\temp",
};

const summary: PreparedInvoiceSummary = {
  issueDate: "15/06/2030",
  issueDateSource: "control_arca",
  issuer: "EMISOR TOTALMENTE FICTICIO",
  issuerCuit: "20000000001",
  issuerCommercialAddress: "Avenida Ficción 100, CABA",
  voucherType: "Factura C",
  pointOfSale: "00001",
  concept: "Servicios",
  currency: "ARS",
  billingPeriodFrom: "01/06/2030",
  billingPeriodTo: "30/06/2030",
  dueDate: "10/07/2030",
  recipientCuit: "20000000001",
  saleCondition: "Otra",
  description: "Prueba",
  amount: "100,00",
  rawContainsExpected: true,
  missingExpectedSignals: [],
};

test("prepared invoice expires and rejects a changed page", () => {
  const store = new PreparedInvoiceStore();
  const state = store.create({ capabilityId: "invoice-services-single-item", operationId: job.operationId, issuerKey: job.issuerKey, job, summary, pageFingerprint: "page-a" }, new Date("2026-01-01T00:00:00Z"));
  assert.throws(() => store.require(state.preparedInvoiceId, job.issuerKey, "page-b", new Date("2026-01-01T00:01:00Z")), /página cambió/i);
});

test("the store requires explicit invalidation before replacing a preparation", () => {
  const store = new PreparedInvoiceStore();
  const first = store.create({ capabilityId: "invoice-services-single-item", operationId: job.operationId, issuerKey: job.issuerKey, job, summary, pageFingerprint: "page" });
  assert.throws(
    () => store.create({ capabilityId: "invoice-services-single-item", operationId: "test-operation-002", issuerKey: job.issuerKey, job: { ...job, operationId: "test-operation-002" }, summary, pageFingerprint: "page" }),
    /invalidarse de forma explícita/i,
  );
  assert.equal(store.invalidate()?.preparedInvoiceId, first.preparedInvoiceId);
  store.create({ capabilityId: "invoice-services-single-item", operationId: "test-operation-002", issuerKey: job.issuerKey, job: { ...job, operationId: "test-operation-002" }, summary, pageFingerprint: "page" });
  assert.throws(() => store.require(first.preparedInvoiceId, job.issuerKey, "page"), /no existe|invalidada/i);
});

test("el estado preparado rechaza CUIT o domicilio del emisor faltante o discrepante", () => {
  const mismatchedCuit = "27000000006";
  assert.throws(() => new PreparedInvoiceStore().create({
    capabilityId: "invoice-services-single-item",
    operationId: job.operationId,
    issuerKey: job.issuerKey,
    job,
    summary: { ...summary, issuerCuit: mismatchedCuit },
    pageFingerprint: "page",
  }), /identidad del emisor.*no coincide/i);
  assert.throws(() => new PreparedInvoiceStore().create({
    capabilityId: "invoice-services-single-item",
    operationId: job.operationId,
    issuerKey: job.issuerKey,
    job,
    summary: { ...summary, issuerCommercialAddress: "" },
    pageFingerprint: "page",
  }), /identidad completa del emisor/i);
});

test("los nuevos campos del resumen quedan inmutables junto con el estado", () => {
  const state = new PreparedInvoiceStore().create({
    capabilityId: "invoice-services-single-item",
    operationId: job.operationId,
    issuerKey: job.issuerKey,
    job,
    summary: { ...summary },
    pageFingerprint: "page",
  });
  assert.equal(Object.isFrozen(state.summary), true);
  assert.throws(() => { state.summary.issuerCommercialAddress = "Otro domicilio"; }, TypeError);
});
