import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrivateInvoiceJob } from "./privateIntake.js";

const input = {
  issuerSelector: "EMISOR FICTICIO",
  recipientCuit: "20000000001",
  recipientName: "RECEPTOR FICTICIO",
  recipientVatCondition: "IVA Responsable Inscripto",
  pointOfSale: "1",
  date: "2030-06-15",
  billingPeriodFrom: "2030-06-01",
  billingPeriodTo: "2030-06-30",
  saleCondition: "Transferencia Bancaria",
  description: "Servicio ficticio",
  amount: "123456.78",
};

test("crea un job privado exclusivo, cerrado al alcance vigente y sin datos en el handle", async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-intake-"));
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const jobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(jobs, { recursive: true });
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const created = await createPrivateInvoiceJob(input, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    randomId: () => id,
    secureFile: async () => undefined,
  });
  assert.equal(created.handle, `invoice-2030-06-15-${id}.json`);
  assert.doesNotMatch(created.handle, /EMISOR|RECEPTOR/iu);
  const saved = JSON.parse(await fs.readFile(path.join(jobs, created.handle), "utf8")) as Record<string, unknown>;
  assert.equal(saved.issuerKey, "20000000001");
  assert.equal(saved.voucherType, "Factura C");
  assert.equal(saved.concept, "Servicios");
  assert.equal(saved.currency, "ARS");
  assert.equal(saved.pointOfSale, "00001");
  assert.equal(saved.dueDate, "2030-06-20");
  assert.equal(saved.outputDir, undefined);
  await assert.rejects(() => createPrivateInvoiceJob(input, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    randomId: () => id,
    secureFile: async () => undefined,
  }), /no se sobrescribió/i);
});

test("redacta fallas de resolución del emisor antes de escribir", async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-intake-resolution-"));
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const jobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(jobs, { recursive: true });
  await assert.rejects(() => createPrivateInvoiceJob(input, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => { throw new Error("perfil privado sensible"); },
    secureFile: async () => undefined,
  }), (error: Error) => {
    assert.match(error.message, /no resolvió exactamente una credencial/i);
    assert.doesNotMatch(error.message, /perfil privado sensible/i);
    return true;
  });
  assert.deepEqual(await fs.readdir(jobs), []);
});
