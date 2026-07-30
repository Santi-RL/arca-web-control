import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ResolvedInvoiceJob } from "../types.js";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { buildInvoiceArtifactPaths, buildInvoiceStagingPdfPath, publishInvoiceArtifacts } from "./invoiceArchive.js";

function invoiceJob(outputDir: string, voucherType = "Factura C"): ResolvedInvoiceJob {
  return {
    schemaVersion: 2,
    operationId: "archive-test-operation-001",
    issuerKey: "20000000001",
    recipientCuit: "20000000001",
    recipientVatCondition: "Consumidor Final",
    voucherType,
    pointOfSale: "00001",
    date: "2030-06-15",
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: "2030-06-01",
    billingPeriodTo: "2030-06-30",
    dueDate: "2030-06-20",
    saleCondition: "Transferencia Bancaria",
    description: "Servicio ficticio",
    amount: 123456.78,
    amountCents: 12_345_678,
    amountDecimal: "123456.78",
    outputDir,
  };
}

const issuer = { cuit: "20000000001", name: "JUAN PÉREZ" };
const cae = "99999999999999";

test("genera la estructura legible y canónica por emisor, período y comprobante", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-invoice-archive-path-");
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const artifacts = await buildInvoiceArtifactPaths(invoiceJob(root), issuer, {
    voucherNumber: "00001-00000042",
    cae,
    pdfSha256: "a".repeat(64),
  }, "job-hash", "2030-06-15T12:00:00.000Z");

  const directory = path.join(root, "Emisores", "20-00000000-1 - JUAN PÉREZ", "Comprobantes Emitidos", "2030", "06");
  assert.equal(artifacts.pdfPath, path.join(directory, "JUAN PÉREZ - FC-C - 00001-00000042.pdf"));
  assert.equal(artifacts.metadataPath, path.join(directory, "JUAN PÉREZ - FC-C - 00001-00000042.json"));
  assert.equal(artifacts.metadata.voucher.number, "00000042");
  assert.equal(artifacts.metadata.pdfFileName, "JUAN PÉREZ - FC-C - 00001-00000042.pdf");
});

test("reutiliza la única carpeta del CUIT aunque cambie la etiqueta y bloquea duplicados", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-invoice-archive-issuer-");
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const issuersRoot = path.join(root, "Emisores");
  await fs.mkdir(path.join(issuersRoot, "20-00000000-1 - ETIQUETA ANTERIOR"), { recursive: true });
  const artifacts = await buildInvoiceArtifactPaths(invoiceJob(root), issuer, {
    voucherNumber: "00001-00000042",
    cae,
    pdfSha256: "a".repeat(64),
  }, "job-hash");
  assert.match(artifacts.pdfPath, /20-00000000-1 - ETIQUETA ANTERIOR/u);

  await fs.mkdir(path.join(issuersRoot, "20-00000000-1 - OTRA ETIQUETA"));
  await assert.rejects(() => buildInvoiceArtifactPaths(invoiceJob(root), issuer, {
    voucherNumber: `00001-${"00000043"}`,
    cae,
    pdfSha256: "b".repeat(64),
  }, "job-hash"), /varias carpetas.*CUIT/i);
});

test("define códigos cerrados para facturas y notas futuras", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-invoice-archive-types-");
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const expectations = [
    ["Factura A", "FC-A"],
    ["Nota de Crédito B", "NC-B"],
    ["Nota de Débito C", "ND-C"],
  ] as const;
  for (const [voucherType, code] of expectations) {
    const artifacts = await buildInvoiceArtifactPaths(invoiceJob(root, voucherType), issuer, {
      voucherNumber: "00001-00000042",
      cae,
      pdfSha256: "a".repeat(64),
    }, "job-hash");
    assert.match(path.basename(artifacts.pdfPath), new RegExp(` - ${code} - `, "u"));
  }
  await assert.rejects(() => buildInvoiceArtifactPaths(invoiceJob(root, "Recibo C"), issuer, {
    voucherNumber: "00001-00000042",
    cae,
    pdfSha256: "a".repeat(64),
  }, "job-hash"), /sin código de archivo definido/i);
});

test("publica PDF y metadatos sin sobrescribir y admite repetición con el mismo hash", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-invoice-archive-publish-");
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF-archivo-ficticio", "utf8");
  const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
  const job = invoiceJob(root);
  const artifacts = await buildInvoiceArtifactPaths(job, issuer, {
    voucherNumber: "00001-00000042",
    cae,
    pdfSha256,
  }, "job-hash", "2030-06-15T12:00:00.000Z");

  const staging = buildInvoiceStagingPdfPath(job.operationId, root);
  await fs.mkdir(path.dirname(staging), { recursive: true });
  await fs.writeFile(staging, bytes, { flag: "wx" });
  const first = await publishInvoiceArtifacts(staging, artifacts, root, root);
  assert.equal(first.pdfPath, artifacts.pdfPath);
  assert.equal(JSON.parse(await fs.readFile(first.metadataPath, "utf8")).pdfSha256, pdfSha256);
  await assert.rejects(() => fs.access(staging));

  await fs.writeFile(staging, bytes, { flag: "wx" });
  assert.deepEqual(await publishInvoiceArtifacts(staging, artifacts, root, root), first);

  const changed = Buffer.from("%PDF-contenido-distinto", "utf8");
  const changedHash = createHash("sha256").update(changed).digest("hex");
  const conflicting = await buildInvoiceArtifactPaths(job, issuer, {
    voucherNumber: "00001-00000042",
    cae,
    pdfSha256: changedHash,
  }, "job-hash");
  await fs.writeFile(staging, changed, { flag: "wx" });
  await assert.rejects(() => publishInvoiceArtifacts(staging, conflicting, root, root), /hash es diferente/i);
});

test("rechaza números cuyo punto de venta no coincide con el job", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-invoice-archive-number-");
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => buildInvoiceArtifactPaths(invoiceJob(root), issuer, {
    voucherNumber: `${"00002"}-00000042`,
    cae,
    pdfSha256: "a".repeat(64),
  }, "job-hash"), /punto de venta/i);
});
