import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalPointOfSale, invoiceJobV2Schema } from "../src/jobs/schema.js";
import { resolveInvoiceDate } from "../src/utils/date.js";

const args = process.argv.slice(2);
const jobPath = args.find((value) => !value.startsWith("--"));
const write = args.includes("--write");
const dryRun = args.includes("--dry-run");
if (!jobPath || write === dryRun) {
  throw new Error("Uso: arca:job:migrate -- <job.json> --dry-run|--write");
}
const current = JSON.parse(await fs.readFile(jobPath, "utf8")) as Record<string, unknown>;
if (current.schemaVersion === 2) throw new Error("El job ya usa schemaVersion 2.");
if (current.currency !== "ARS") {
  throw new Error("La migración requiere declarar currency: ARS de forma explícita en el job de origen; no se inferirá la moneda.");
}
const migrated = {
  ...current,
  schemaVersion: 2,
  operationId: typeof current.operationId === "string" ? current.operationId : randomUUID(),
  recipientCuit: String(current.recipientCuit || "").replace(/\D/g, ""),
  pointOfSale: canonicalPointOfSale(current.pointOfSale),
  date: resolveInvoiceDate(String(current.date || "")),
  currency: current.currency,
  billingPeriodFrom: current.billingPeriodFrom ? resolveInvoiceDate(String(current.billingPeriodFrom)) : undefined,
  billingPeriodTo: current.billingPeriodTo ? resolveInvoiceDate(String(current.billingPeriodTo)) : undefined,
  dueDate: current.dueDate ? resolveInvoiceDate(String(current.dueDate)) : undefined,
  amount: typeof current.amount === "number" ? current.amount.toFixed(2) : String(current.amount),
};
const validated = invoiceJobV2Schema.parse(migrated);
if (write) {
  const temporary = `${jobPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await fs.rename(temporary, jobPath);
  console.log(`JOB_MIGRATED=${jobPath}`);
} else {
  console.log(JSON.stringify(validated, null, 2));
}
