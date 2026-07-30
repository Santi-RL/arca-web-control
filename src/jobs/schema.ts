import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { InvoiceJob, ResolvedInvoiceJob } from "../types.js";
import { getRuntimePaths } from "../config/runtimePaths.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Debe usar fecha ISO YYYY-MM-DD.").refine(isRealIsoDate, "Fecha inválida.");
const cuit = z.string()
  .trim()
  .regex(/^\d{11}$/, "El CUIT debe contener exactamente once dígitos, sin texto ni separadores.")
  .refine((value) => isValidCuit(value), "CUIT inválido.");
const decimalAmount = z.string().regex(/^\d{1,10}\.\d{2}$/, "amount debe ser una cadena decimal con dos decimales.");
const outputSubdirectory = z.string().trim().min(1).superRefine((value, context) => {
  try {
    validateOutputSubdirectory(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "outputDir inválido.",
    });
  }
});

export const invoiceJobV2Schema = z.object({
  schemaVersion: z.literal(2),
  operationId: z.string().trim().min(8).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]+$/),
  issuerKey: cuit,
  recipientCuit: cuit,
  recipientName: z.string().trim().min(1).optional(),
  recipientVatCondition: z.string().trim().min(1),
  recipientCommercialAddress: z.string().trim().min(1).optional(),
  voucherType: z.string().trim().min(1),
  pointOfSale: z.string().trim().regex(/^\d{1,5}$/, "pointOfSale debe contener entre uno y cinco dígitos.").transform((value) => value.padStart(5, "0")),
  date: isoDate,
  concept: z.string().trim().min(1),
  currency: z.literal("ARS", { error: "La capacidad actual exige currency: ARS." }),
  billingPeriodFrom: isoDate.optional(),
  billingPeriodTo: isoDate.optional(),
  dueDate: isoDate.optional(),
  specificRegime: z.enum(["meat-remit", "flour-remit", "conditioned-tobacco-remit"]).optional(),
  activity: z.string().trim().min(1).optional(),
  saleCondition: z.string().trim().min(1),
  description: z.string().trim().min(1).max(1000),
  unit: z.string().trim().min(1).optional(),
  amount: decimalAmount,
  outputDir: outputSubdirectory.optional().default("."),
}).strict().superRefine((job, context) => {
  if (job.billingPeriodFrom && job.billingPeriodTo && job.billingPeriodFrom > job.billingPeriodTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["billingPeriodTo"], message: "El fin del período no puede ser anterior al inicio." });
  }
  if (/servicios/i.test(job.concept)) {
    for (const field of ["billingPeriodFrom", "billingPeriodTo"] as const) {
      if (!job[field]) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `El concepto Servicios requiere ${field}.` });
    }
  }
  if (job.specificRegime && !job.activity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activity"],
      message: "Un specificRegime requiere informar activity para evitar asociaciones fiscales implícitas.",
    });
  }
  if (job.dueDate && job.dueDate < job.date) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueDate"], message: "El vencimiento no puede ser anterior a la fecha de emisión." });
  }
}).transform((job) => /servicios/i.test(job.concept) && !job.dueDate
  ? { ...job, dueDate: addCalendarDaysIso(job.date, 5) }
  : job);

export async function loadInvoiceJob(jobPath: string, downloadsRoot?: string): Promise<ResolvedInvoiceJob> {
  const absolutePath = path.resolve(jobPath);
  const rawValue = JSON.parse(await fs.readFile(absolutePath, "utf8")) as { schemaVersion?: unknown };
  if (rawValue.schemaVersion !== 2) {
    throw new Error(`El job ${absolutePath} usa schema v1 o no declara versión. Ejecutá arca:job:migrate antes de usarlo.`);
  }
  const parsed = invoiceJobV2Schema.parse(rawValue) satisfies InvoiceJob;
  const amountCents = decimalToCents(parsed.amount);
  return {
    ...parsed,
    recipientCuit: parsed.recipientCuit,
    amount: amountCents / 100,
    amountCents,
    amountDecimal: parsed.amount,
    outputDir: resolvePrivateOutputDir(parsed.outputDir, downloadsRoot),
  };
}

export function resolvePrivateOutputDir(value: string, downloadsRoot = getRuntimePaths().downloads): string {
  const segments = validateOutputSubdirectory(value);
  const root = path.resolve(downloadsRoot);
  const resolved = segments.length === 0 ? root : path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error("outputDir debe permanecer dentro de la carpeta privada downloads.");
  }
  return resolved;
}

function validateOutputSubdirectory(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === ".") return [];
  if (
    path.isAbsolute(trimmed)
    || path.win32.isAbsolute(trimmed)
    || path.posix.isAbsolute(trimmed)
    || /^[a-zA-Z]:/.test(trimmed)
    || /^(?:\\\\|\/\/)/.test(trimmed)
  ) {
    throw new Error("outputDir debe ser '.' o una subcarpeta relativa dentro de downloads; no se admiten rutas absolutas ni UNC.");
  }
  const segments = trimmed.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("outputDir no puede contener segmentos vacíos, '.' ni '..'.");
  }
  if (segments.some((segment) => !/^[\p{L}\p{N}._ -]+$/u.test(segment) || /[. ]$/u.test(segment))) {
    throw new Error("outputDir contiene caracteres o terminaciones no permitidos para una subcarpeta privada.");
  }
  return segments;
}

export function canonicalPointOfSale(value: unknown): string {
  const digits = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(digits)) throw new Error("pointOfSale debe contener exclusivamente entre uno y cinco dígitos.");
  return digits.padStart(5, "0");
}

export function decimalToCents(value: string): number {
  const [integer, fraction] = value.split(".");
  const cents = Number(integer) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Importe fuera de rango.");
  return cents;
}

export function isValidCuit(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  const remainder = 11 - (sum % 11);
  const verifier = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
  return verifier === Number(value[10]);
}

function isRealIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function addCalendarDaysIso(value: string, days: number): string {
  if (!isRealIsoDate(value) || !Number.isInteger(days)) throw new Error("No se puede calcular el vencimiento con una fecha o cantidad de días inválida.");
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
