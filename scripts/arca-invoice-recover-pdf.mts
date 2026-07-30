import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadInvoiceJob } from "../src/jobs/schema.js";
import { buildPreparedInvoicePdfPath } from "../src/arca/liveSession.js";
import { hashCanonicalJob } from "../src/arca/preparedInvoice.js";
import { inspectArcaInvoicePdf } from "../src/arca/invoicePdf.js";
import { OperationLedger } from "../src/arca/operationLedger.js";
import { sha256File } from "../src/arca/emission.js";
import { publishReservedPdf, reservePrivatePdfDestination } from "../src/config/privateDownloads.js";
import { resolveCredentialRoutingIdentity } from "../src/config/env.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";

const runtime = getRuntimePaths();
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

const source = await validateSource(sourcePath);
const loadedJob = await loadInvoiceJob(jobPath, runtime.downloads);
const identity = resolveCredentialRoutingIdentity(loadedJob.issuerKey);
const job = { ...loadedJob, issuerKey: identity.issuerKey };
const evidence = await inspectArcaInvoicePdf(source, {
  voucherType: job.voucherType,
  pointOfSale: job.pointOfSale,
  issueDate: formatDate(job.date),
  recipientCuit: job.recipientCuit,
  description: job.description,
  amountCents: job.amountCents,
});
const sourceSha256 = await sha256File(source);
const target = buildPreparedInvoicePdfPath(job);
const ledger = new OperationLedger(runtime.ledger);
const jobHash = hashCanonicalJob(job);
const current = await ledger.get(job.operationId);
if (!current || current.status !== "unknown" || current.jobHash !== jobHash) {
  throw new Error(`La recuperación exige que el ledger esté en unknown y asociado al mismo job; estado actual: ${current?.status ?? "inexistente"}.`);
}

if (dryRun) {
  console.log("DRY_RUN=1");
  console.log(`VOUCHER_NUMBER=${evidence.voucherNumber}`);
  console.log(`CAE=${evidence.cae}`);
  console.log(`PDF_PAGES=${evidence.pageCount}`);
  console.log(`PDF_SHA256=${sourceSha256}`);
  console.log(`TARGET=${target}`);
  process.exit(0);
}

const reservation = await reservePrivatePdfDestination(target, runtime.downloads, runtime.root);
let pdfPath: string;
try {
  await fs.copyFile(source, reservation.temporaryPath, fsConstants.COPYFILE_EXCL);
  pdfPath = await publishReservedPdf(reservation);
} finally {
  await reservation.release();
}
const pdfSha256 = await sha256File(pdfPath);
if (pdfSha256 !== sourceSha256) throw new Error("El hash del PDF publicado no coincide con la descarga validada.");
await ledger.reconcileUnknownAsEmitted(job.operationId, jobHash, {
  voucherNumber: evidence.voucherNumber,
  cae: evidence.cae,
  pdfPath,
  pdfSha256,
});
console.log("RECOVERED=1");
console.log("LEDGER_STATUS=emitted");
console.log(`VOUCHER_NUMBER=${evidence.voucherNumber}`);
console.log(`CAE=${evidence.cae}`);
console.log(`PDF_PAGES=${evidence.pageCount}`);
console.log(`PDF_SHA256=${pdfSha256}`);
console.log(`PDF_PATH=${pdfPath}`);

async function validateSource(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("La fuente de recuperación debe ser un archivo regular, no un enlace.");
  if (stat.size < 1_024 || stat.size > 50 * 1024 * 1024) throw new Error("El tamaño del PDF de recuperación está fuera del rango permitido.");
  const real = await fs.realpath(resolved);
  const repository = await fs.realpath(process.cwd());
  const relative = path.relative(repository, real);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("El PDF fiscal de recuperación no puede estar dentro del repositorio.");
  }
  return real;
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
