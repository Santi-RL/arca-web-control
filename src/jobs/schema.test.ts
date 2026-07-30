import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addCalendarDaysIso, canonicalPointOfSale, decimalToCents, invoiceJobV2Schema, isValidCuit, loadInvoiceJob } from "./schema.js";

const validJob = {
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
  saleCondition: "Transferencia Bancaria",
  description: "Honorarios profesionales",
  amount: "100000.00",
  outputDir: ".",
};

test("loadInvoiceJob valida v2, centavos y outputDir", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-"));
  const jobPath = path.join(dir, "job.json");
  const downloadsRoot = path.join(dir, "runtime", "downloads");
  await fs.writeFile(jobPath, JSON.stringify({ ...validJob, outputDir: "receptor-ficticio/2030-06" }));
  const job = await loadInvoiceJob(jobPath, downloadsRoot);
  assert.equal(job.amountCents, 10000000);
  assert.equal(job.amountDecimal, "100000.00");
  assert.equal(job.outputDir, path.join(downloadsRoot, "receptor-ficticio", "2030-06"));
});

test("loadInvoiceJob rechaza v1 con instrucción de migración", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-"));
  const jobPath = path.join(dir, "job.json");
  await fs.writeFile(jobPath, JSON.stringify({ issuerKey: "contribuyente_ficticio" }));
  await assert.rejects(() => loadInvoiceJob(jobPath), /migrate/i);
});

test("valida CUIT, dinero y coherencia fiscal básica", () => {
  assert.equal(isValidCuit("20000000001"), true);
  assert.equal(isValidCuit("20000000002"), false);
  assert.equal(decimalToCents("3000000.00"), 300000000);
  assert.equal(canonicalPointOfSale("0001"), "00001");
  assert.throws(() => canonicalPointOfSale("1-2"), /exclusivamente/);
  assert.throws(() => canonicalPointOfSale("1.5"), /exclusivamente/);
  const legacyPointOfSale = invoiceJobV2Schema.parse({ ...validJob, pointOfSale: "0001" });
  assert.equal(legacyPointOfSale.pointOfSale, "00001");
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, issuerKey: "contribuyente_ficticio" }), /CUIT/i);
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, issuerKey: `emisor-${validJob.issuerKey}` }), /once dígitos/i);
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, recipientCuit: `CUIT ${validJob.recipientCuit}` }), /once dígitos/i);
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, recipientVatCondition: undefined }), /recipientVatCondition|invalid/i);
});

test("Servicios aplica vencimiento de cinco días corridos cuando se omite", () => {
  const parsed = invoiceJobV2Schema.parse({ ...validJob, dueDate: undefined });
  assert.equal(parsed.dueDate, "2030-06-20");
  assert.equal(addCalendarDaysIso("2030-06-15", 5), "2030-06-20");
  const explicit = invoiceJobV2Schema.parse({ ...validJob, dueDate: "2030-07-10" });
  assert.equal(explicit.dueDate, "2030-07-10");
});

test("currency es obligatoria y queda cerrada en ARS", () => {
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, currency: undefined }), /currency|invalid/i);
  assert.equal(invoiceJobV2Schema.parse(validJob).currency, "ARS");
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, currency: "USD" }), /exige.*ARS/i);
});

test("actividad v2 conserva compatibilidad y los regímenes exigen actividad", () => {
  const legacyActivity = invoiceJobV2Schema.parse({ ...validJob, activity: "620100" });
  assert.equal(legacyActivity.activity, "620100");
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, specificRegime: "meat-remit" }), /activity/);
  const parsed = invoiceJobV2Schema.parse({ ...validJob, specificRegime: "meat-remit", activity: "101011" });
  assert.equal(parsed.specificRegime, "meat-remit");
});

test("invoice-job-v2 rechaza variantes no modeladas en lugar de ignorarlas", () => {
  assert.throws(() => invoiceJobV2Schema.parse({
    ...validJob,
    items: [
      { description: "Servicio uno", amount: "50000.00" },
      { description: "Servicio dos", amount: "50000.00" },
    ],
  }), /items/i);
});

test("invoice-job-v2 rechaza destinos absolutos y traversal antes de resolver el job", () => {
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, outputDir: path.resolve("destino.pdf") }), /relativa|absolutas/i);
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, outputDir: "../fuera" }), /\.\./i);
  assert.throws(() => invoiceJobV2Schema.parse({ ...validJob, outputDir: "\\\\servidor\\facturas" }), /UNC|absolutas/i);
});
