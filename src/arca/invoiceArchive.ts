import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedInvoiceJob } from "../types.js";
import { publishReservedPdf, reservePrivatePdfDestination } from "../config/privateDownloads.js";
import { acquireLocalOsMutex } from "../io/osMutex.js";

export type InvoiceIssuerIdentity = {
  cuit: string;
  name: string;
};

export type InvoiceArtifactEvidence = {
  voucherNumber: string;
  cae: string;
  pdfSha256: string;
};

export type InvoiceArtifactMetadata = {
  schemaVersion: 1;
  operationId: string;
  jobHash: string;
  issuer: InvoiceIssuerIdentity;
  voucher: {
    type: string;
    code: string;
    letter: "A" | "B" | "C";
    pointOfSale: string;
    number: string;
    fullNumber: string;
  };
  issueDate: string;
  cae: string;
  pdfSha256: string;
  pdfFileName: string;
  archivedAt: string;
};

export type InvoiceArtifactPaths = {
  pdfPath: string;
  metadataPath: string;
  metadata: InvoiceArtifactMetadata;
};

export function buildInvoiceStagingPdfPath(operationId: string, downloadsRoot: string): string {
  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  return path.join(downloadsRoot, ".staging", `${digest}.pdf`);
}

export async function buildInvoiceArtifactPaths(
  job: ResolvedInvoiceJob,
  issuer: InvoiceIssuerIdentity,
  evidence: InvoiceArtifactEvidence,
  jobHash: string,
  archivedAt = new Date().toISOString(),
): Promise<InvoiceArtifactPaths> {
  const issuerCuit = canonicalCuit(issuer.cuit);
  if (issuerCuit !== canonicalCuit(job.issuerKey)) {
    throw new Error("El CUIT del archivo no coincide con el emisor del job.");
  }
  const issuerName = validateIssuerDisplayName(issuer.name);
  const issuerFileLabel = sanitizeWindowsLabel(issuerName, "Emisor", 48);
  const voucher = parseVoucherType(job.voucherType);
  const voucherNumber = parseVoucherNumber(evidence.voucherNumber);
  if (voucherNumber.pointOfSale !== job.pointOfSale.padStart(5, "0")) {
    throw new Error("El número de comprobante no coincide con el punto de venta del job.");
  }
  if (!/^\d{14}$/u.test(evidence.cae)) throw new Error("El CAE del comprobante no tiene un formato verificable.");
  if (!/^[a-f0-9]{64}$/iu.test(evidence.pdfSha256)) throw new Error("El hash SHA-256 del PDF no tiene un formato verificable.");
  const date = parseIsoDate(job.date);
  const issuerDirectory = await resolveIssuerDirectory(job.outputDir, issuerCuit, issuerFileLabel);
  const fileStem = `${issuerDirectory.fileLabel} - ${voucher.code}-${voucher.letter} - ${voucherNumber.fullNumber}`;
  const directory = path.join(
    job.outputDir,
    "Emisores",
    issuerDirectory.name,
    "Comprobantes Emitidos",
    date.year,
    date.month,
  );
  const pdfPath = path.join(directory, `${fileStem}.pdf`);
  const metadataPath = path.join(directory, `${fileStem}.json`);
  return {
    pdfPath,
    metadataPath,
    metadata: {
      schemaVersion: 1,
      operationId: job.operationId,
      jobHash,
      issuer: { cuit: issuerCuit, name: issuerName },
      voucher: {
        type: job.voucherType,
        code: voucher.code,
        letter: voucher.letter,
        pointOfSale: voucherNumber.pointOfSale,
        number: voucherNumber.number,
        fullNumber: voucherNumber.fullNumber,
      },
      issueDate: job.date,
      cae: evidence.cae,
      pdfSha256: evidence.pdfSha256.toLowerCase(),
      pdfFileName: path.basename(pdfPath),
      archivedAt,
    },
  };
}

export async function publishInvoiceArtifactsForJob(
  sourcePdfPath: string,
  job: ResolvedInvoiceJob,
  issuer: InvoiceIssuerIdentity,
  evidence: InvoiceArtifactEvidence,
  jobHash: string,
  allowedRoot: string,
  trustedRoot: string,
  archivedAt = new Date().toISOString(),
): Promise<{ pdfPath: string; metadataPath: string; pdfSha256: string }> {
  const issuerCuit = canonicalCuit(issuer.cuit);
  if (issuerCuit !== canonicalCuit(job.issuerKey)) {
    throw new Error("El CUIT del archivo no coincide con el emisor del job.");
  }
  const releaseIssuerArchive = await acquireLocalOsMutex(
    issuerArchiveMutexIdentity(job.outputDir, issuerCuit),
    "el archivo privado del emisor",
    { timeoutMs: 30_000, retryDelayMs: 50 },
  );
  try {
    const artifacts = await buildInvoiceArtifactPaths(job, issuer, evidence, jobHash, archivedAt);
    return await publishResolvedInvoiceArtifacts(sourcePdfPath, artifacts, allowedRoot, trustedRoot);
  } finally {
    await releaseIssuerArchive();
  }
}

async function publishResolvedInvoiceArtifacts(
  sourcePdfPath: string,
  artifacts: InvoiceArtifactPaths,
  allowedRoot: string,
  trustedRoot: string,
): Promise<{ pdfPath: string; metadataPath: string; pdfSha256: string }> {
  const source = await validateExistingPrivateFile(sourcePdfPath, allowedRoot, trustedRoot, ".pdf");
  const sourceHash = await sha256File(source);
  if (sourceHash !== artifacts.metadata.pdfSha256) {
    throw new Error("El hash del PDF en staging no coincide con la evidencia validada.");
  }

  const pdfPath = await publishPdfIdempotently(source, artifacts.pdfPath, sourceHash, allowedRoot, trustedRoot);
  const finalPdf = await validateExistingPrivateFile(pdfPath, allowedRoot, trustedRoot, ".pdf");
  const finalPdfSha256 = await sha256File(finalPdf);
  if (finalPdfSha256 !== sourceHash || finalPdfSha256 !== artifacts.metadata.pdfSha256) {
    throw new Error("El hash del PDF canónico publicado no coincide con la descarga validada.");
  }
  await publishMetadataIdempotently(artifacts.metadataPath, artifacts.metadata, allowedRoot, trustedRoot);
  if (!samePath(source, pdfPath)) await fs.rm(source, { force: true });
  return { pdfPath, metadataPath: artifacts.metadataPath, pdfSha256: finalPdfSha256 };
}

function issuerArchiveMutexIdentity(outputDir: string, issuerCuit: string): string {
  const resolvedRoot = path.resolve(outputDir);
  const normalizedRoot = process.platform === "win32"
    ? resolvedRoot.toLocaleLowerCase("en-US")
    : resolvedRoot;
  return `invoice-issuer-archive\0${normalizedRoot}\0${issuerCuit}`;
}

async function resolveIssuerDirectory(outputDir: string, issuerCuit: string, issuerName: string): Promise<{ name: string; fileLabel: string }> {
  const formattedCuit = formatCuit(issuerCuit);
  const prefix = `${formattedCuit} - `;
  const issuersRoot = path.join(outputDir, "Emisores");
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(issuersRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { name: `${prefix}${issuerName}`, fileLabel: issuerName };
    throw error;
  }
  const matches = entries.filter((entry) => entry.name.toLocaleLowerCase("es-AR").startsWith(prefix.toLocaleLowerCase("es-AR")));
  if (matches.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`La carpeta privada del emisor ${formattedCuit} no es un directorio regular.`);
  }
  if (matches.length > 1) {
    throw new Error(`Existen varias carpetas privadas para el CUIT ${formattedCuit}; se requiere revisión manual.`);
  }
  const existing = matches[0]?.name;
  if (!existing) return { name: `${prefix}${issuerName}`, fileLabel: issuerName };
  const stableLabel = sanitizeWindowsLabel(existing.slice(prefix.length), "Emisor", 48);
  return { name: existing, fileLabel: stableLabel };
}

async function publishPdfIdempotently(
  source: string,
  destination: string,
  sourceHash: string,
  allowedRoot: string,
  trustedRoot: string,
): Promise<string> {
  let reservation;
  try {
    reservation = await reservePrivatePdfDestination(destination, allowedRoot, trustedRoot);
  } catch (error) {
    const existing = await validateExistingPrivateFileIfExists(destination, allowedRoot, trustedRoot, ".pdf");
    if (!existing) throw error;
    const existingHash = await sha256File(existing);
    if (existingHash !== sourceHash) {
      throw new Error("Ya existe un PDF con el mismo comprobante, pero su hash es diferente; no se sobrescribirá.");
    }
    return existing;
  }
  try {
    await fs.copyFile(source, reservation.temporaryPath, fsConstants.COPYFILE_EXCL);
    return await publishReservedPdf(reservation);
  } finally {
    await reservation.release();
  }
}

async function publishMetadataIdempotently(
  destination: string,
  metadata: InvoiceArtifactMetadata,
  allowedRoot: string,
  trustedRoot: string,
): Promise<void> {
  const existing = await validateExistingPrivateFileIfExists(destination, allowedRoot, trustedRoot, ".json");
  if (existing) {
    const parsed = JSON.parse(await fs.readFile(existing, "utf8")) as unknown;
    if (!metadataMatches(parsed, metadata)) {
      throw new Error("Ya existen metadatos diferentes para el mismo comprobante; no se sobrescribirán.");
    }
    return;
  }

  const parent = path.dirname(destination);
  await validatePrivateParent(parent, allowedRoot, trustedRoot);
  const temporary = path.join(parent, `.${path.basename(destination, ".json")}.${randomUUID()}.tmp.json`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.link(temporary, destination);
  } catch (error) {
    const raced = await validateExistingPrivateFileIfExists(destination, allowedRoot, trustedRoot, ".json");
    if (!raced) throw error;
    const parsed = JSON.parse(await fs.readFile(raced, "utf8")) as unknown;
    if (!metadataMatches(parsed, metadata)) {
      throw new Error("Los metadatos aparecieron durante la publicación con contenido diferente; no se sobrescribirán.");
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function validateExistingPrivateFileIfExists(
  value: string,
  allowedRoot: string,
  trustedRoot: string,
  extension: ".pdf" | ".json",
): Promise<string | undefined> {
  try {
    return await validateExistingPrivateFile(value, allowedRoot, trustedRoot, extension);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateExistingPrivateFile(
  value: string,
  allowedRoot: string,
  trustedRoot: string,
  extension: ".pdf" | ".json",
): Promise<string> {
  const resolved = path.resolve(value);
  if (path.extname(resolved).toLocaleLowerCase("en-US") !== extension) {
    throw new Error(`El artefacto privado debe terminar en ${extension}.`);
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("El artefacto privado debe ser un archivo regular con una única identidad; no se admiten enlaces ni hard links.");
  }
  const real = await fs.realpath(resolved);
  if (!samePath(real, resolved)) throw new Error("El artefacto privado no puede atravesar enlaces o junctions.");
  await validateContainedPath(real, allowedRoot, trustedRoot);
  return real;
}

async function validatePrivateParent(parent: string, allowedRoot: string, trustedRoot: string): Promise<void> {
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("La carpeta del artefacto privado no es un directorio regular.");
  const real = await fs.realpath(parent);
  if (!samePath(real, path.resolve(parent))) throw new Error("La carpeta del artefacto privado no puede atravesar enlaces o junctions.");
  await validateContainedPath(real, allowedRoot, trustedRoot);
}

async function validateContainedPath(candidate: string, allowedRoot: string, trustedRoot: string): Promise<void> {
  const allowed = await fs.realpath(allowedRoot);
  const trusted = await fs.realpath(trustedRoot);
  const repository = await fs.realpath(process.cwd());
  if (!isWithin(trusted, allowed) || !isWithin(allowed, candidate) || isWithin(repository, candidate)) {
    throw new Error("El artefacto no pertenece al almacenamiento privado aprobado.");
  }
}

function metadataMatches(value: unknown, expected: InvoiceArtifactMetadata): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Partial<InvoiceArtifactMetadata>;
  return actual.schemaVersion === expected.schemaVersion
    && actual.operationId === expected.operationId
    && actual.jobHash === expected.jobHash
    && actual.issuer?.cuit === expected.issuer.cuit
    && actual.issuer?.name === expected.issuer.name
    && actual.voucher?.type === expected.voucher.type
    && actual.voucher?.code === expected.voucher.code
    && actual.voucher?.letter === expected.voucher.letter
    && actual.voucher?.pointOfSale === expected.voucher.pointOfSale
    && actual.voucher?.number === expected.voucher.number
    && actual.voucher?.fullNumber === expected.voucher.fullNumber
    && actual.issueDate === expected.issueDate
    && actual.cae === expected.cae
    && actual.pdfSha256?.toLowerCase() === expected.pdfSha256
    && actual.pdfFileName === expected.pdfFileName;
}

function parseVoucherType(value: string): { code: "FC" | "NC" | "ND"; letter: "A" | "B" | "C" } {
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("es-AR");
  const match = normalized.match(/^(factura|nota de credito|nota de debito) ([abc])$/u);
  if (!match?.[1] || !match[2]) throw new Error(`Tipo de comprobante sin código de archivo definido: ${value}.`);
  const codes = { factura: "FC", "nota de credito": "NC", "nota de debito": "ND" } as const;
  return { code: codes[match[1] as keyof typeof codes], letter: match[2].toUpperCase() as "A" | "B" | "C" };
}

function parseVoucherNumber(value: string): { pointOfSale: string; number: string; fullNumber: string } {
  const match = value.match(/^(\d{5})-(\d{8})$/u);
  if (!match?.[1] || !match[2]) throw new Error("El número de comprobante debe usar el formato <PPPPP>-<NNNNNNNN>.");
  return { pointOfSale: match[1], number: match[2], fullNumber: `${match[1]}-${match[2]}` };
}

function parseIsoDate(value: string): { year: string; month: string } {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!match?.[1] || !match[2] || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("La fecha de emisión no tiene formato ISO válido.");
  }
  return { year: match[1], month: match[2] };
}

function canonicalCuit(value: string): string {
  const digits = value.replace(/\D/gu, "");
  if (!/^\d{11}$/u.test(digits)) throw new Error("El CUIT del archivo debe contener once dígitos.");
  return digits;
}

function formatCuit(value: string): string {
  return `${value.slice(0, 2)}-${value.slice(2, 10)}-${value.slice(10)}`;
}

function sanitizeWindowsLabel(value: string, fallback: string, maximumLength: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  const safe = !normalized || reserved.test(normalized) ? fallback : normalized;
  return Array.from(safe).slice(0, maximumLength).join("").replace(/[. ]+$/gu, "") || fallback;
}

function validateIssuerDisplayName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized) || Array.from(normalized).length > 200) {
    throw new Error("El nombre verificado del emisor no es válido para los metadatos privados.");
  }
  return normalized;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
