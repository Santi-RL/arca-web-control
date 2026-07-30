import path from "node:path";
import { Download } from "playwright";
import { ResolvedInvoiceJob } from "../types.js";
import { publishReservedPdf, reservePrivatePdfDestination } from "../config/privateDownloads.js";
import { getRuntimePaths } from "../config/runtimePaths.js";

function sanitizeFilePart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function saveInvoicePdf(download: Download, job: ResolvedInvoiceJob): Promise<string> {
  const suggested = download.suggestedFilename();
  const extension = path.extname(suggested).toLowerCase() === ".pdf" ? ".pdf" : ".pdf";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = [
    "Factura",
    sanitizeFilePart(job.voucherType ?? "comprobante"),
    sanitizeFilePart(job.issuerKey),
    sanitizeFilePart(job.recipientCuit),
    job.date,
    timestamp,
  ].filter(Boolean).join("_") + extension;

  const targetPath = path.join(job.outputDir, fileName);
  const runtime = getRuntimePaths();
  const reservation = await reservePrivatePdfDestination(targetPath, runtime.downloads, runtime.root);
  try {
    await download.saveAs(reservation.temporaryPath);
    return await publishReservedPdf(reservation);
  } finally {
    await reservation.release();
  }
}
