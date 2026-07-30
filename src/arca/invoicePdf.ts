import fs from "node:fs/promises";
import type { Download, Locator, Page } from "playwright";
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

type GeneratedInvoiceDownload = Pick<Download, "failure" | "saveAs" | "cancel">;

export async function downloadGeneratedInvoicePdf(
  page: Page,
  reservation: PdfDestinationReservation,
  timeoutMs = 30_000,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("El timeout de descarga PDF es inválido.");
  assertOfficialArcaGeneratedInvoicePageUrl(page.url());
  const controls = page.getByRole("button", { name: /^Imprimir(?:\.{3}|…)?$/i })
    .or(page.getByRole("link", { name: /^Imprimir(?:\.{3}|…)?$/i }));
  const visible = await visibleLocators(controls);
  if (visible.length !== 1) throw new Error(`Imprimir: se esperaba un único control visible y se encontraron ${visible.length}. No se abrió ninguna URL alternativa.`);

  const deadline = Date.now() + timeoutMs;
  let download: Download;
  try {
    assertOfficialArcaGeneratedInvoicePageUrl(page.url());
    [download] = await beforeDeadline(Promise.all([
      page.waitForEvent("download", { timeout: remainingMilliseconds(deadline) }),
      visible[0]!.click({ timeout: remainingMilliseconds(deadline) }),
    ]), deadline);
  } catch {
    throw new Error("ARCA accionó Imprimir, pero no se pudo capturar la descarga. No se reintentó el clic.");
  }
  return await persistGeneratedInvoiceDownload(download, reservation, deadline);
}

export async function persistGeneratedInvoiceDownload(
  download: GeneratedInvoiceDownload,
  reservation: PdfDestinationReservation,
  deadline: number,
): Promise<string> {
  try {
    const failure = await beforeDeadline(download.failure(), deadline);
    if (failure) throw new Error("ARCA inició la descarga del comprobante, pero el navegador informó una falla.");
    await beforeDeadline(download.saveAs(reservation.temporaryPath), deadline);
  } catch (error) {
    if (error instanceof DownloadDeadlineError) {
      reservation.preserveTemporary();
      void download.cancel().catch(() => undefined);
      throw new Error("La descarga del comprobante no terminó dentro del plazo seguro. No se reintentó el clic y cualquier resultado debe reconciliarse.");
    }
    throw error;
  }
  await assertPdfSignature(reservation.temporaryPath);
  return await publishReservedPdf(reservation);
}

class DownloadDeadlineError extends Error {}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = remainingMilliseconds(deadline);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DownloadDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingMilliseconds(deadline: number): number {
  if (!Number.isFinite(deadline)) throw new Error("El plazo de descarga PDF es inválido.");
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining <= 0) throw new DownloadDeadlineError();
  return remaining;
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

    const voucherReference = extractVoucherReference(text);
    const caeCandidates = [...new Set(text.match(/\b\d{14}\b/g) ?? [])];
    if (caeCandidates.length !== 1 || !caeCandidates[0]) throw new Error("No se pudo extraer un CAE único del PDF de ARCA.");

    return {
      voucherNumber: `${voucherReference.pointOfSale}-${voucherReference.number}`,
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
    [normalizeText(expected.issueDate), "fecha de emisión"],
    [normalizeText(expected.description), "descripción"],
    ["comprobante autorizado", "estado autorizado"],
  ] as const;
  for (const [signal, label] of expectedSignals) {
    if (!normalizedText.includes(signal)) throw new Error(`El PDF de ARCA no coincide con el ${label} esperado.`);
  }

  assertExpectedVoucherType(normalizedText, expected.voucherType);
  if (!cuitPattern(expected.recipientCuit).test(text)) {
    throw new Error("El PDF de ARCA no coincide con el CUIT del receptor esperado.");
  }

  const voucherReference = extractVoucherReference(text);
  if (voucherReference.pointOfSale !== expected.pointOfSale.padStart(5, "0")) {
    throw new Error("El PDF de ARCA no coincide con el punto de venta esperado.");
  }
  const labelledTotals = [...text.matchAll(/Importe\s+Total\s*:?\s*(?:\$|ARS)?\s*(\d[\d.\s]*[,.]\d{2})/giu)]
    .map((match) => parsePdfMoney(match[1] ?? ""));
  if (labelledTotals.length !== 1 || labelledTotals[0] !== expected.amountCents) {
    throw new Error("El PDF de ARCA no coincide con el Importe Total esperado.");
  }

  const descriptionIndex = normalizedText.indexOf(normalizeText(expected.description));
  const afterDescription = normalizedText.slice(descriptionIndex + normalizeText(expected.description).length);
  const totalIndex = afterDescription.indexOf("importe total");
  const itemAndSubtotalBlock = afterDescription.slice(0, totalIndex >= 0 ? totalIndex : 1200).slice(0, 1200);
  const itemMonies = [...itemAndSubtotalBlock.matchAll(/\d[\d.\s]*[,.]\d{2}/gu)]
    .map((match) => ({ index: match.index, cents: parsePdfMoney(match[0]) }));
  const firstExpectedMoney = itemMonies.find((item) => item.cents === expected.amountCents);
  const expectedMoneyCount = itemMonies.filter((item) => item.cents === expected.amountCents).length;
  const quantityPrefix = firstExpectedMoney ? itemAndSubtotalBlock.slice(0, firstExpectedMoney.index) : "";
  if (!/(?:^|\s)1(?:[.,]0{1,4})?(?=\s|$)/u.test(quantityPrefix)) {
    throw new Error("El PDF de ARCA no confirma cantidad 1 para el único ítem esperado.");
  }
  if (expectedMoneyCount < 2) {
    throw new Error("El PDF de ARCA no confirma precio unitario y subtotal del único ítem esperado.");
  }
}

function extractVoucherReference(text: string): { pointOfSale: string; number: string } {
  const patterns = [
    /Punto\s+de\s+Venta\s*:\s*(\d{1,5})\s+Comp\.?\s*Nro\.?\s*:\s*(\d{6,8})/giu,
    /Punto\s+de\s+Venta\s*:\s*Comp\.?\s*Nro\.?\s*:?\s*(\d{1,5})\s+(\d{6,8})/giu,
  ];
  const references: Array<{ pointOfSale: string; number: string }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const pointOfSale = match[1];
      const number = match[2];
      if (pointOfSale && number) references.push({ pointOfSale: pointOfSale.padStart(5, "0"), number: number.padStart(8, "0") });
    }
  }
  const unique = [...new Map(references.map((reference) => [`${reference.pointOfSale}-${reference.number}`, reference])).values()];
  if (unique.length !== 1 || !unique[0]) {
    throw new Error("No se pudo extraer un único punto de venta y número etiquetados del PDF de ARCA.");
  }
  return unique[0];
}

function assertExpectedVoucherType(normalizedText: string, expectedVoucherType: string): void {
  const expected = /^factura\s+([abc])$/u.exec(normalizeText(expectedVoucherType));
  if (!expected?.[1] || !normalizedText.includes("factura")) {
    throw new Error("El PDF de ARCA no coincide con el tipo de comprobante esperado.");
  }
  const letter = expected[1];
  const codeByLetter: Record<string, string> = { a: "001", b: "006", c: "011" };
  const contiguous = new RegExp(`(?:^|\\s)factura\\s+${letter}(?:\\s|$)`, "u").test(normalizedText);
  const separated = new RegExp(`(?:^|\\s)${letter}\\s*(?:/|\\s)+cod\\.?\\s*0*${Number(codeByLetter[letter])}(?:\\s|/|$)`, "u").test(normalizedText);
  if (!contiguous && !separated) {
    throw new Error("El PDF de ARCA no coincide con la letra y el código del comprobante esperado.");
  }
}

function cuitPattern(value: string): RegExp {
  const digits = value.replace(/\D/gu, "");
  if (!/^\d{11}$/u.test(digits)) throw new Error("El CUIT esperado para validar el PDF es inválido.");
  return new RegExp(`(?<!\\d)${digits.slice(0, 2)}(?:-|\\s)?${digits.slice(2, 10)}(?:-|\\s)?${digits.slice(10)}(?!\\d)`, "u");
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
