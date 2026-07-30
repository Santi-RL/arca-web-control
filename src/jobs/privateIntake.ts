import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensurePrivateFile } from "../config/runtimePaths.js";
import { invoiceJobV2Schema } from "./schema.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const privateInvoiceIntakeSchema = z.object({
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
  randomId?: () => string;
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
  } catch {
    throw new Error("El emisor no resolvió exactamente una credencial local; indicá su CUIT para desambiguar.");
  }
  if (issuer.issuerKey !== issuer.cuit) {
    throw new Error("La identidad canónica del emisor no coincide con su CUIT.");
  }

  const randomId = options.randomId ?? randomUUID;
  const suffix = randomId().toLowerCase();
  if (!/^[a-f0-9-]{16,64}$/u.test(suffix)) throw new Error("No se pudo generar un identificador privado seguro.");
  const operationId = `invoice-${input.date}-${suffix}`;
  const handle = `${operationId}.json`;
  const destination = await resolveNewPrivateJobDestination(
    handle,
    options.privateJobsRoot,
    options.trustedRuntimeRoot,
  );

  const parsed = invoiceJobV2Schema.parse({
    schemaVersion: 2,
    operationId,
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
      throw new Error("El identificador privado del job ya existe; no se sobrescribió ningún archivo.");
    }
    throw error;
  }

  return { handle, operationId };
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
