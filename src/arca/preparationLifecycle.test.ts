import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationLedger } from "./operationLedger.js";
import { PreparedInvoiceStore, type PreparedInvoiceSummary } from "./preparedInvoice.js";
import { invalidatePreparationBeforeMutation } from "./preparationLifecycle.js";
import { ResolvedInvoiceJob } from "../types.js";

const baseJob: ResolvedInvoiceJob = {
  schemaVersion: 2,
  operationId: "operation-old-001",
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
  dueDate: "2030-06-20",
  saleCondition: "Otra",
  description: "Servicio ficticio",
  amount: 100,
  amountCents: 10000,
  amountDecimal: "100.00",
  outputDir: ".",
};

const baseSummary: PreparedInvoiceSummary = {
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
  dueDate: "20/06/2030",
  recipientCuit: "20000000001",
  saleCondition: "Otra",
  description: "Servicio ficticio",
  amount: "100,00",
  rawContainsExpected: true,
  missingExpectedSignals: [],
};

function createState(store: PreparedInvoiceStore, job: ResolvedInvoiceJob, preparedInvoiceId: string) {
  return store.create({
    preparedInvoiceId,
    capabilityId: "invoice-services-single-item",
    operationId: job.operationId,
    issuerKey: job.issuerKey,
    job,
    summary: baseSummary,
    pageFingerprint: "summary-page",
  });
}

test("una nueva preparación invalida store y ledger anteriores antes de quedar activa", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-prepare-lifecycle-"));
  const ledger = new OperationLedger(directory);
  const store = new PreparedInvoiceStore();
  const oldState = createState(store, baseJob, "prepared-old");
  await ledger.claimPreparation(oldState.operationId, oldState.jobHash, oldState.preparedInvoiceId);

  await invalidatePreparationBeforeMutation(store, ledger, async () => "summary-page", "Reemplazada por una preparación nueva.");

  assert.equal(store.current, undefined);
  assert.equal((await ledger.get(oldState.operationId))?.status, "failed_before_emit");

  const newJob = { ...baseJob, operationId: "operation-new-001" };
  const newState = createState(store, newJob, "prepared-new");
  await ledger.claimPreparation(newState.operationId, newState.jobHash, newState.preparedInvoiceId);

  assert.equal(store.current, newState);
  assert.equal((await ledger.get(newState.operationId))?.status, "prepared");
  assert.throws(() => store.require("prepared-old", baseJob.issuerKey, "summary-page"), /no existe|invalidada/i);
});

test("un fallo de preflight previo al nuevo ledger y create no deja utilizable la preparación anterior", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-prepare-lifecycle-"));
  const ledger = new OperationLedger(directory);
  const store = new PreparedInvoiceStore();
  const oldState = createState(store, baseJob, "prepared-old");
  await ledger.claimPreparation(oldState.operationId, oldState.jobHash, oldState.preparedInvoiceId);

  await assert.rejects(async () => {
    await invalidatePreparationBeforeMutation(store, ledger, async () => "summary-page", "Se inició otra preparación.");
    throw new Error("Falló el preflight del job nuevo.");
  }, /Falló el preflight/);

  assert.equal(store.current, undefined);
  assert.equal((await ledger.get(oldState.operationId))?.status, "failed_before_emit");
  assert.equal(await ledger.get("operation-never-claimed"), undefined);
  assert.throws(() => store.require("prepared-old", baseJob.issuerKey, "summary-page"), /no existe|invalidada/i);
});

test("si la página cambió, la preparación retirada queda unknown y no admite reintento", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-prepare-lifecycle-"));
  const ledger = new OperationLedger(directory);
  const store = new PreparedInvoiceStore();
  const oldState = createState(store, baseJob, "prepared-old");
  await ledger.claimPreparation(oldState.operationId, oldState.jobHash, oldState.preparedInvoiceId);

  await invalidatePreparationBeforeMutation(store, ledger, async () => "different-page", "Se inició otra preparación.");

  assert.equal(store.current, undefined);
  assert.equal((await ledger.get(oldState.operationId))?.status, "unknown");
  await assert.rejects(
    () => ledger.claimPreparation(oldState.operationId, oldState.jobHash, "prepared-next"),
    /estado unknown/,
  );
});

test("un fallo al persistir la invalidación retira el ID anterior y bloquea la mutación", async () => {
  const store = new PreparedInvoiceStore();
  const oldState = createState(store, baseJob, "prepared-old");
  const failingLedger = {
    markFailedBeforeEmit: async () => { throw new Error("ledger no disponible"); },
    markPreparedUnknown: async () => { throw new Error("ledger no disponible"); },
  };

  await assert.rejects(
    () => invalidatePreparationBeforeMutation(store, failingLedger, async () => "summary-page", "Se inició otra preparación."),
    /ledger no disponible/,
  );

  assert.equal(store.current, undefined);
  assert.throws(() => store.require(oldState.preparedInvoiceId, baseJob.issuerKey, "summary-page"), /no existe|invalidada/i);
});
