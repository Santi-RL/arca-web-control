import fs from "node:fs/promises";
import type { Locator, Page } from "playwright";
import type { PdfDestinationReservation } from "../config/privateDownloads.js";
import { publishReservedPdf } from "../config/privateDownloads.js";
import { assertOfficialArcaGeneratedInvoicePageUrl } from "./officialUrls.js";

export type ArcaInvoicePdfExpectation = {
  voucherType: string;
  pointOfSale: string;
  issueDate: string;
  recipientCuit: string;
  description: string;
  amountCents: number;
};

export type ArcaInvoicePdfEvidence = {
  voucherNumber: string;
  cae: string;
  pageCount: number;
};

export async function downloadGeneratedInvoicePdf(
  page: Page,
  reservation: PdfDestinationReservation,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("El timeout de descarga PDF es inválido.");
  assertOfficialArcaGeneratedInvoicePageUrl(page.url());
  const controls = page.getByRole("button", { name: /^Imprimir(?:\.{3}|…)?$/i })
    .or(page.getByRole("link", { name: /^Imprimir(?:\.{3}|…)?$/i }));
  const visible = await visibleLocators(controls);
  if (visible.length === 0) return undefined;
  if (visible.length !== 1) throw new Error(`Imprimir: se esperaba un único control visible y se encontraron ${visible.length}.`);

  let download;
  try {
    assertOfficialArcaGeneratedInvoicePageUrl(page.url());
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: timeoutMs }),
      visible[0]!.click(),
    ]);
  } catch {
    throw new Error("ARCA accionó Imprimir, pero no se pudo capturar la descarga. No se reintentó el clic.");
  }
  const failure = await download.failure();
  if (failure) throw new Error("ARCA inició la descarga del comprobante, pero el navegador informó una falla.");
  await download.saveAs(reservation.temporaryPath);
  await assertPdfSignature(reservation.temporaryPath);
  return await publishReservedPdf(reservation);
}

export async function inspectArcaInvoicePdf(
  pdfPath: string,
  expected: ArcaInvoicePdfExpectation,
): Promise<ArcaInvoicePdfEvidence> {
  const bytes = await fs.readFile(pdfPath);
  assertPdfBytes(bytes);

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new Error("El PDF descargado no contiene páginas.");
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
    assertExpectedInvoiceText(text, expected);

    const voucherMatch = text.match(/Punto de Venta:\s*Comp\.?\s*Nro\.?\s*:?\s*(\d{1,5})\s+(\d{6,8})/i);
    if (!voucherMatch?.[1] || !voucherMatch[2]) throw new Error("No se pudo extraer punto de venta y número del PDF de ARCA.");
    const caeCandidates = [...new Set(text.match(/\b\d{14}\b/g) ?? [])];
    if (caeCandidates.length !== 1 || !caeCandidates[0]) throw new Error("No se pudo extraer un CAE único del PDF de ARCA.");

    return {
      voucherNumber: `${voucherMatch[1].padStart(5, "0")}-${voucherMatch[2].padStart(8, "0")}`,
      cae: caeCandidates[0],
      pageCount: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function assertPdfSignature(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(5);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== 5) throw new Error("La descarga de ARCA no tiene una firma PDF válida.");
    assertPdfBytes(bytes);
  } finally {
    await handle.close();
  }
}

function assertPdfBytes(bytes: Uint8Array): void {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("La descarga de ARCA no tiene una firma PDF válida.");
  }
}

function assertExpectedInvoiceText(text: string, expected: ArcaInvoicePdfExpectation): void {
  const normalizedText = normalizeText(text);
  const expectedSignals = [
    [normalizeText(expected.voucherType), "tipo de comprobante"],
    [normalizeText(expected.issueDate), "fecha de emisión"],
    [normalizeText(expected.recipientCuit), "CUIT del receptor"],
    [normalizeText(expected.description), "descripción"],
    ["comprobante autorizado", "estado autorizado"],
  ] as const;
  for (const [signal, label] of expectedSignals) {
    if (!normalizedText.includes(signal)) throw new Error(`El PDF de ARCA no coincide con el ${label} esperado.`);
  }

  const voucherMatch = text.match(/Punto de Venta:\s*Comp\.?\s*Nro\.?\s*:?\s*(\d{1,5})\s+(\d{6,8})/i);
  if (!voucherMatch?.[1] || voucherMatch[1].padStart(5, "0") !== expected.pointOfSale.padStart(5, "0")) {
    throw new Error("El PDF de ARCA no coincide con el punto de venta esperado.");
  }
  const monetaryValues = text.match(/\d[\d.\s]*[,.]\d{2}/g) ?? [];
  if (!monetaryValues.some((value) => parsePdfMoney(value) === expected.amountCents)) {
    throw new Error("El PDF de ARCA no coincide con el importe esperado.");
  }
}

function parsePdfMoney(value: string): number | undefined {
  const compact = value.replace(/\s/g, "");
  const separator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  if (separator < 0 || compact.length - separator - 1 !== 2) return undefined;
  const whole = compact.slice(0, separator).replace(/\D/g, "") || "0";
  const fraction = compact.slice(separator + 1).replace(/\D/g, "");
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) result.push(current);
  }
  return result;
}
