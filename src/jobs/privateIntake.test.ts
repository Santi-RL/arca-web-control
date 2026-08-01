import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { OperationLedger } from "../arca/operationLedger.js";
import { resolvePrivateInvoiceJobPath } from "../config/privateJobs.js";
import { createPrivateInvoiceJob, privateInvoiceIntakeSchema } from "./privateIntake.js";

const input = {
  intentId: "00000000-0000-4000-8000-000000000001",
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
  const runtime = await makeCanonicalTemporaryDirectory("arca-job-intake-");
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const jobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(jobs, { recursive: true });
  const created = await createPrivateInvoiceJob(input, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  });
  assert.match(created.handle, /^invoice-[a-f0-9]{64}\.json$/u);
  assert.doesNotMatch(created.handle, /2030-06-15/);
  assert.doesNotMatch(created.handle, /EMISOR|RECEPTOR/iu);
  assert.equal(
    await resolvePrivateInvoiceJobPath(created.handle, jobs, runtime),
    await fs.realpath(path.join(jobs, created.handle)),
  );
  const saved = JSON.parse(await fs.readFile(path.join(jobs, created.handle), "utf8")) as Record<string, unknown>;
  assert.equal(saved.issuerKey, "20000000001");
  assert.equal(saved.voucherType, "Factura C");
  assert.equal(saved.concept, "Servicios");
  assert.equal(saved.currency, "ARS");
  assert.equal(saved.pointOfSale, "00001");
  assert.equal(saved.dueDate, "2030-06-20");
  assert.equal(saved.outputDir, undefined);
  assert.equal(Object.hasOwn(saved, "recipientKind"), false);
  const reused = await createPrivateInvoiceJob(input, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  });
  assert.deepEqual(reused, created);
  assert.equal((await fs.readdir(jobs)).length, 1);

  await assert.rejects(() => createPrivateInvoiceJob({ ...input, amount: "123456.79" }, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  }), /colisionó con otro contenido/);

  const distinct = await createPrivateInvoiceJob({ ...input, intentId: "00000000-0000-4000-8000-000000000002" }, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  });
  assert.notEqual(distinct.operationId, created.operationId);
  assert.equal((await fs.readdir(jobs)).length, 2);
});

test("persiste el discriminante anónimo sin CUIT, nombre ni domicilio", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-job-intake-anonymous-");
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const jobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(jobs, { recursive: true });
  const { recipientCuit: _recipientCuit, recipientName: _recipientName, ...anonymousInput } = input;
  const rawAnonymous = {
    ...anonymousInput,
    intentId: "00000000-0000-4000-8000-000000000004",
    recipientKind: "anonymous-final-consumer",
    recipientVatCondition: "Consumidor Final",
  };
  const created = await createPrivateInvoiceJob(rawAnonymous, {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  });
  const saved = JSON.parse(await fs.readFile(path.join(jobs, created.handle), "utf8")) as Record<string, unknown>;
  assert.equal(saved.recipientKind, "anonymous-final-consumer");
  assert.equal(saved.recipientVatCondition, "Consumidor Final");
  assert.equal(Object.hasOwn(saved, "recipientCuit"), false);
  assert.equal(Object.hasOwn(saved, "recipientName"), false);
  assert.equal(Object.hasOwn(saved, "recipientCommercialAddress"), false);

  assert.equal(privateInvoiceIntakeSchema.safeParse({ ...rawAnonymous, recipientVatCondition: "IVA Responsable Inscripto" }).success, false);
  assert.equal(privateInvoiceIntakeSchema.safeParse({ ...rawAnonymous, recipientCuit: "20000000001" }).success, false);
  assert.equal(privateInvoiceIntakeSchema.safeParse({ ...rawAnonymous, recipientName: "RECEPTOR FICTICIO" }).success, false);
  assert.equal(privateInvoiceIntakeSchema.safeParse({ ...rawAnonymous, recipientCommercialAddress: "DOMICILIO FICTICIO 123" }).success, false);
});

test("redacta fallas de resolución del emisor antes de escribir", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-job-intake-resolution-");
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

test("una selección humana de domicilio revisa el mismo intento solo antes del límite irreversible", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-job-intake-revision-");
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const jobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(jobs, { recursive: true });
  const options = {
    privateJobsRoot: jobs,
    trustedRuntimeRoot: runtime,
    resolveIssuer: () => ({ issuerKey: "20000000001", cuit: "20000000001" }),
    secureFile: async () => undefined,
  };
  const first = await createPrivateInvoiceJob(input, options);
  const firstHash = createHash("sha256").update(await fs.readFile(path.join(jobs, first.handle))).digest("hex");
  const ledger = new OperationLedger(path.join(runtime, "ledger"));
  await ledger.claimPreparation(first.operationId, firstHash, "prepared-address-1");
  await ledger.markFailedBeforeEmit(first.operationId, "prepared-address-1", firstHash, "ARCA devolvió más de un domicilio.");

  const revised = await createPrivateInvoiceJob({
    ...input,
    intentRevision: 2,
    recipientCommercialAddress: "DOMICILIO FICTICIO 123",
  }, options);
  const revisedHash = createHash("sha256").update(await fs.readFile(path.join(jobs, revised.handle))).digest("hex");
  assert.equal(revised.operationId, first.operationId);
  assert.notEqual(revised.handle, first.handle);
  assert.notEqual(revisedHash, firstHash);
  await ledger.claimPreparation(revised.operationId, revisedHash, "prepared-address-2");
  await ledger.markPreparedUnknown(revised.operationId, "prepared-address-2", revisedHash, "La página pudo cambiar.");

  const forbiddenRevision = await createPrivateInvoiceJob({
    ...input,
    intentRevision: 3,
    recipientCommercialAddress: "OTRO DOMICILIO FICTICIO 456",
  }, options);
  const forbiddenHash = createHash("sha256").update(await fs.readFile(path.join(jobs, forbiddenRevision.handle))).digest("hex");
  await assert.rejects(
    () => ledger.claimPreparation(forbiddenRevision.operationId, forbiddenHash, "prepared-address-3"),
    /unknown.*prohibido/i,
  );
});
