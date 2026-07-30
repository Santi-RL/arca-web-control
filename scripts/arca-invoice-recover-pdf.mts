import { parseInvoiceJobJson } from "../src/jobs/schema.js";
import { hashCanonicalJob } from "../src/arca/preparedInvoice.js";
import { inspectArcaInvoicePdf } from "../src/arca/invoicePdf.js";
import { OperationLedger } from "../src/arca/operationLedger.js";
import { sha256File } from "../src/arca/emission.js";
import { resolveCredentialRoutingIdentity } from "../src/config/env.js";
import { ensureRuntimeLayout, getRuntimePaths } from "../src/config/runtimePaths.js";
import { buildInvoiceArtifactPaths, publishInvoiceArtifactsForJob } from "../src/arca/invoiceArchive.js";
import { readPrivateInvoiceJobFile } from "../src/config/privateJobs.js";
import { stagePrivateRecoveryPdf } from "../src/config/privateRecoveryPdf.js";

const runtime = await ensureRuntimeLayout(getRuntimePaths());
const confirmation = "RECUPERAR_Y_RECONCILIAR";
const values = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
};
const jobPath = option("--job");
const sourcePath = option("--source");
const write = values.includes("--write");
const dryRun = values.includes("--dry-run");
if (!jobPath || !sourcePath || write === dryRun || (write && values.at(-1) !== confirmation)) {
  throw new Error(`Uso: arca:invoice:recover-pdf -- --job <job-v2> --source <pdf-descargado> --dry-run | --write ${confirmation}`);
}

const privateJob = await readPrivateInvoiceJobFile(jobPath, runtime.privateJobs, runtime.root);
const loadedJob = parseInvoiceJobJson(privateJob.contents, privateJob.path, runtime.downloads);
const identity = resolveCredentialRoutingIdentity(loadedJob.issuerKey);
const job = { ...loadedJob, issuerKey: identity.issuerKey };
const ledger = new OperationLedger(runtime.ledger);
const jobHash = hashCanonicalJob(job);
const current = await ledger.get(job.operationId);
if (!current || current.status !== "unknown" || current.jobHash !== jobHash) {
  throw new Error(`La recuperación exige que el ledger esté en unknown y asociado al mismo job; estado actual: ${current?.status ?? "inexistente"}.`);
}
if (!current.issuer) {
  throw new Error("El ledger unknown no contiene la identidad verificada del emisor necesaria para el archivo canónico.");
}
const stableSource = await stagePrivateRecoveryPdf(sourcePath, job.operationId, runtime.downloads, runtime.root);
try {
  const evidence = await inspectArcaInvoicePdf(stableSource.path, {
    voucherType: job.voucherType,
    pointOfSale: job.pointOfSale,
    issueDate: formatDate(job.date),
    recipientCuit: job.recipientCuit,
    description: job.description,
    amountCents: job.amountCents,
  });
  const sourceSha256 = await sha256File(stableSource.path);
  const artifacts = await buildInvoiceArtifactPaths(job, current.issuer, {
    voucherNumber: evidence.voucherNumber,
    cae: evidence.cae,
    pdfSha256: sourceSha256,
  }, jobHash);

  if (dryRun) {
    console.log("DRY_RUN=1");
    console.log(`VOUCHER_NUMBER=${evidence.voucherNumber}`);
    console.log(`CAE=${evidence.cae}`);
    console.log(`PDF_PAGES=${evidence.pageCount}`);
    console.log(`PDF_SHA256=${sourceSha256}`);
    console.log(`PDF_TARGET=${artifacts.pdfPath}`);
    console.log(`METADATA_TARGET=${artifacts.metadataPath}`);
  } else {
    const stagingPdfPath = await stableSource.publish();
    const published = await publishInvoiceArtifactsForJob(stagingPdfPath, job, current.issuer, {
      voucherNumber: evidence.voucherNumber,
      cae: evidence.cae,
      pdfSha256: sourceSha256,
    }, jobHash, runtime.downloads, runtime.root);
    const pdfSha256 = await sha256File(published.pdfPath);
    if (pdfSha256 !== sourceSha256) throw new Error("El hash del PDF publicado no coincide con la copia privada validada.");
    await ledger.reconcileUnknownAsEmitted(job.operationId, jobHash, {
      voucherNumber: evidence.voucherNumber,
      cae: evidence.cae,
      pdfPath: published.pdfPath,
      metadataPath: published.metadataPath,
      pdfSha256,
    });
    console.log("RECOVERED=1");
    console.log("LEDGER_STATUS=emitted");
    console.log(`VOUCHER_NUMBER=${evidence.voucherNumber}`);
    console.log(`CAE=${evidence.cae}`);
    console.log(`PDF_PAGES=${evidence.pageCount}`);
    console.log(`PDF_SHA256=${pdfSha256}`);
    console.log(`PDF_PATH=${published.pdfPath}`);
    console.log(`METADATA_PATH=${published.metadataPath}`);
  }
} finally {
  await stableSource.release();
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
