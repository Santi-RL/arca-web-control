import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensurePrivateFile } from "../config/runtimePaths.js";
import { CredentialProviderError } from "../config/credentialProvider.js";
import { invoiceJobV2Schema } from "./schema.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const privateInvoiceIntakeSchema = z.object({
  intentId: z.string().uuid(),
  intentRevision: z.number().int().min(1).max(9999).default(1),
  issuerSelector: z.string().trim().min(1).max(200),
  recipientCuit: z.string().trim().min(1),
  recipientName: z.string().trim().min(1).optional(),
  recipientVatCondition: z.string().trim().min(1),
  recipientCommercialAddress: z.string().trim().min(1).optional(),
  pointOfSale: z.string().trim().min(1),
  date: isoDate,
  billingPeriodFrom: isoDate,
  billingPeriodTo: isoDate,
  dueDate: isoDate.optional(),
  saleCondition: z.string().trim().min(1),
  description: z.string().trim().min(1).max(1000),
  amount: z.string().trim().min(1),
}).strict();

export type PrivateInvoiceIntake = z.input<typeof privateInvoiceIntakeSchema>;

export type PrivateInvoiceJobResult = {
  handle: string;
  operationId: string;
};

type CreatePrivateInvoiceJobOptions = {
  privateJobsRoot: string;
  trustedRuntimeRoot: string;
  resolveIssuer: (selector: string) => { issuerKey: string; cuit: string };
  secureFile?: (filePath: string) => Promise<void>;
};

export async function createPrivateInvoiceJob(
  rawInput: unknown,
  options: CreatePrivateInvoiceJobOptions,
): Promise<PrivateInvoiceJobResult> {
  const input = privateInvoiceIntakeSchema.parse(rawInput);
  let issuer: { issuerKey: string; cuit: string };
  try {
    issuer = options.resolveIssuer(input.issuerSelector);
  } catch (error) {
    if (error instanceof CredentialProviderError) throw error;
    throw new Error("El emisor no resolvió exactamente una credencial local; indicá su CUIT para desambiguar.");
  }
  if (issuer.issuerKey !== issuer.cuit) {
    throw new Error("La identidad canónica del emisor no coincide con su CUIT.");
  }

  const normalizedWithoutIdentity = invoiceJobV2Schema.parse({
    schemaVersion: 2,
    operationId: "invoice-idempotency-seed",
    issuerKey: issuer.cuit,
    recipientCuit: input.recipientCuit,
    recipientName: input.recipientName,
    recipientVatCondition: input.recipientVatCondition,
    recipientCommercialAddress: input.recipientCommercialAddress,
    voucherType: "Factura C",
    pointOfSale: input.pointOfSale,
    date: input.date,
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: input.billingPeriodFrom,
    billingPeriodTo: input.billingPeriodTo,
    dueDate: input.dueDate,
    saleCondition: input.saleCondition,
    description: input.description,
    amount: input.amount,
  });
  const { operationId: _seed, ...canonicalInvoice } = normalizedWithoutIdentity;
  // La intención distingue comprobantes legítimamente idénticos y permanece
  // estable en los reintentos de una misma solicitud conversacional. No se
  // deriva del payload fiscal: campos opcionales/defaults no pueden eludir ni
  // fusionar accidentalmente un estado unknown/emitted.
  const intentDigest = createHash("sha256").update(`invoice-intent-v1\0${input.intentId}`, "utf8").digest("hex");
  const revisionDigest = createHash("sha256").update(`invoice-intent-revision-v1\0${input.intentId}\0${input.intentRevision}`, "utf8").digest("hex");
  const operationId = `invoice-chat-${intentDigest}`;
  const handle = `invoice-${revisionDigest}.json`;
  const destination = await resolveNewPrivateJobDestination(
    handle,
    options.privateJobsRoot,
    options.trustedRuntimeRoot,
  );

  const parsed = invoiceJobV2Schema.parse({ ...canonicalInvoice, operationId });
  const persisted = { ...parsed } as Record<string, unknown>;
  if (persisted.outputDir === ".") delete persisted.outputDir;

  let created = false;
  try {
    const file = await fs.open(destination, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await (options.secureFile ?? ensurePrivateFile)(destination);
  } catch (error) {
    if (created) await fs.unlink(destination).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readExistingCanonicalJobAfterConcurrentCreate(destination);
      if (isDeepStrictEqual(jsonValue(existing), jsonValue(parsed))) {
        await (options.secureFile ?? ensurePrivateFile)(destination);
        return { handle, operationId };
      }
      throw new Error("El identificador idempotente del job colisionó con otro contenido; no se sobrescribió ningún archivo.");
    }
    throw error;
  }

  return { handle, operationId };
}

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readExistingCanonicalJob(filePath: string): Promise<ReturnType<typeof invoiceJobV2Schema.parse>> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-existing-job");
    return invoiceJobV2Schema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    throw new Error("El job idempotente existente no es un archivo canónico válido; se requiere revisión manual.");
  }
}

async function readExistingCanonicalJobAfterConcurrentCreate(filePath: string): Promise<ReturnType<typeof invoiceJobV2Schema.parse>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readExistingCanonicalJob(filePath);
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError;
}

async function resolveNewPrivateJobDestination(handle: string, privateJobsRoot: string, trustedRuntimeRoot: string): Promise<string> {
  const runtime = path.resolve(trustedRuntimeRoot);
  const jobs = path.resolve(privateJobsRoot);
  const runtimeStat = await fs.lstat(runtime);
  const jobsStat = await fs.lstat(jobs);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || !jobsStat.isDirectory() || jobsStat.isSymbolicLink()) {
    throw new Error("La estructura privada de jobs no es válida.");
  }
  const runtimeReal = await fs.realpath(runtime);
  const jobsReal = await fs.realpath(jobs);
  const repositoryReal = await fs.realpath(process.cwd());
  if (!isWithin(runtimeReal, jobsReal) || isWithin(repositoryReal, jobsReal)) {
    throw new Error("La carpeta privada de jobs no está contenida en el runtime local.");
  }
  const destination = path.resolve(jobs, handle);
  if (path.dirname(destination) !== jobs || path.extname(destination).toLowerCase() !== ".json") {
    throw new Error("El identificador privado del job no es válido.");
  }
  return destination;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
