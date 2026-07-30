import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CapabilityMaturity, ResolvedInvoiceJob } from "../types.js";

export const maturityOrder = ["observed", "assisted", "automated_to_summary", "controlled_irreversible", "fast_path"] as const;
const invoiceCommands = ["prepare-invoice", "emit-prepared-invoice"] as const;
const hiddenRuntimeCommands = new Set(["status", "snapshot", "screenshot", ...invoiceCommands]);
const invoiceRuntimeScopeSchema = z.object({
  kind: z.literal("invoice"),
  voucherType: z.string().trim().min(1),
  concept: z.string().trim().min(1),
  currency: z.literal("ARS"),
  itemCount: z.number().int().positive(),
}).strict();
const capabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  title: z.string().min(1),
  maturity: z.enum(maturityOrder),
  hiddenAllowed: z.boolean(),
  commands: z.array(z.string().min(1)).min(1),
  irreversibleAction: z.string().min(1).nullable(),
  confirmation: z.string().min(1).nullable(),
  recovery: z.string().min(1),
  inputSchema: z.string().min(1).nullable(),
  runtimeScope: invoiceRuntimeScopeSchema.nullable(),
  testEvidence: z.array(z.string().min(1)),
  realEvidence: z.array(z.string().min(1)),
  lastValidatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  lastValidatedVisible: z.boolean(),
}).superRefine((capability, context) => {
  if (capability.hiddenAllowed && capability.maturity !== "fast_path") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hiddenAllowed"], message: "Solo fast_path puede habilitar modo oculto." });
  }
  if (capability.irreversibleAction && !capability.confirmation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: "Una acción irreversible requiere confirmación." });
  }
  if (capability.lastValidatedVisible && (!capability.lastValidatedAt || capability.realEvidence.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lastValidatedVisible"], message: "Una validación visible requiere fecha y evidencia real." });
  }
  if (capability.lastValidatedAt && !capability.lastValidatedVisible) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lastValidatedAt"], message: "Una fecha de validación requiere lastValidatedVisible=true." });
  }
  if (capability.maturity === "fast_path" && (!capability.lastValidatedVisible || !capability.lastValidatedAt || capability.testEvidence.length === 0 || capability.realEvidence.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maturity"], message: "fast_path requiere pruebas, evidencia real y una validación visible fechada." });
  }
  if (maturityRank(capability.maturity) >= maturityRank("controlled_irreversible")) {
    if (!capability.irreversibleAction || !capability.confirmation || capability.testEvidence.length === 0 || capability.realEvidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maturity"],
        message: "controlled_irreversible requiere acción y confirmación explícitas, pruebas y evidencia real revisable.",
      });
    }
  }
  if (capability.hiddenAllowed) {
    if (capability.runtimeScope?.kind !== "invoice") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeScope"], message: "El modo oculto solo admite actualmente capacidades de facturación con alcance cerrado." });
    }
    const disallowed = capability.commands.filter((command) => !hiddenRuntimeCommands.has(command));
    if (disallowed.length > 0 || !invoiceCommands.every((command) => capability.commands.includes(command))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["commands"], message: "El modo oculto solo admite lectura y la ruta preparada de facturación completa." });
    }
  }
  const registeredInvoiceCommands = capability.commands.filter((command) => invoiceCommands.includes(command as InvoiceCapabilityCommand));
  if (registeredInvoiceCommands.length > 0 && capability.runtimeScope?.kind !== "invoice") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeScope"], message: "Los comandos de facturación requieren un alcance runtime explícito." });
  }
  if (capability.runtimeScope?.kind === "invoice" && capability.inputSchema !== "invoice-job-v2") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inputSchema"], message: "El alcance de facturación actual requiere invoice-job-v2." });
  }
  if (capability.runtimeScope?.kind === "invoice" && capability.commands.includes("emit-prepared-invoice")) {
    if (!capability.irreversibleAction || capability.confirmation !== "EMITIR") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: "Toda emisión de factura requiere una acción irreversible declarada y confirmación exacta EMITIR." });
    }
  }
  if (capability.commands.includes("emit-prepared-invoice") && maturityRank(capability.maturity) < maturityRank("controlled_irreversible")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maturity"], message: "La emisión requiere madurez controlled_irreversible o fast_path." });
  }
});

export type CapabilityManifest = z.infer<typeof capabilitySchema>;
export type InvoiceCapabilityCommand = typeof invoiceCommands[number];
export type InvoiceRuntimeRequest = {
  command: InvoiceCapabilityCommand;
  voucherType: string;
  concept: string;
  currency: string;
  itemCount: number;
  capabilityId?: string;
  requireHidden?: boolean;
};

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  return capabilitySchema.parse(value);
}

export async function loadCapabilityRegistry(root = path.resolve("config", "capabilities")): Promise<CapabilityManifest[]> {
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const manifests = await Promise.all(entries.map(async (entry) => {
    const parsed = parseCapabilityManifest(JSON.parse(await fs.readFile(path.join(root, entry.name), "utf8")));
    if (`${parsed.id}.json` !== entry.name) throw new Error(`El manifiesto ${entry.name} no coincide con id=${parsed.id}.`);
    return parsed;
  }));
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) throw new Error(`Capacidad duplicada: ${manifest.id}`);
    ids.add(manifest.id);
  }
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}

export async function requireHiddenCapability(id: string): Promise<CapabilityManifest> {
  const capability = (await loadCapabilityRegistry()).find((item) => item.id === id);
  if (!capability) throw new Error(`Capacidad desconocida: ${id}.`);
  assertHiddenAllowed(capability);
  return capability;
}

export async function requireInvoiceJobCapability(
  job: Pick<ResolvedInvoiceJob, "voucherType" | "concept" | "currency">,
  command: InvoiceCapabilityCommand,
  options: { capabilityId?: string; requireHidden?: boolean; registryRoot?: string } = {},
): Promise<CapabilityManifest> {
  return requireInvoiceCapability({
    command,
    voucherType: job.voucherType,
    concept: job.concept,
    currency: job.currency,
    itemCount: 1,
    capabilityId: options.capabilityId,
    requireHidden: options.requireHidden,
  }, options.registryRoot);
}

export async function requireInvoiceCapability(
  request: InvoiceRuntimeRequest,
  root = path.resolve("config", "capabilities"),
): Promise<CapabilityManifest> {
  if (!Number.isInteger(request.itemCount) || request.itemCount <= 0) {
    throw new Error("La cantidad de ítems de la factura debe ser un entero positivo.");
  }

  const registry = await loadCapabilityRegistry(root);
  const requestedRegistry = request.capabilityId
    ? registry.filter((capability) => capability.id === request.capabilityId)
    : registry;
  if (request.capabilityId && requestedRegistry.length === 0) {
    throw new Error(`Capacidad desconocida: ${request.capabilityId}.`);
  }

  const minimumMaturity = request.command === "emit-prepared-invoice"
    ? "controlled_irreversible"
    : "automated_to_summary";
  const matches = requestedRegistry.filter((capability) => {
    const scope = capability.runtimeScope;
    if (scope?.kind !== "invoice") return false;
    if (!capability.commands.includes(request.command)) return false;
    if (maturityRank(capability.maturity) < maturityRank(minimumMaturity)) return false;
    if (canonicalRuntimeValue(scope.voucherType) !== canonicalRuntimeValue(request.voucherType)) return false;
    if (canonicalRuntimeValue(scope.concept) !== canonicalRuntimeValue(request.concept)) return false;
    if (canonicalRuntimeValue(scope.currency) !== canonicalRuntimeValue(request.currency)) return false;
    if (scope.itemCount !== request.itemCount) return false;
    if (request.command === "emit-prepared-invoice" && capability.confirmation !== "EMITIR") return false;
    return true;
  });

  if (matches.length === 0) {
    throw new Error(
      `La factura solicitada no coincide con una capacidad registrada para ${request.command}. `
      + "Usá el modo de aprendizaje visible para incorporar esta variante antes de operarla.",
    );
  }
  if (matches.length > 1) {
    throw new Error(`La factura coincide con ${matches.length} capacidades registradas; el alcance es ambiguo y la operación fue bloqueada.`);
  }

  const capability = matches[0] as CapabilityManifest;
  if (request.requireHidden) assertHiddenAllowed(capability);
  return capability;
}

export function isMaturity(value: string): value is CapabilityMaturity {
  return maturityOrder.includes(value as CapabilityMaturity);
}

function maturityRank(value: CapabilityMaturity): number {
  return maturityOrder.indexOf(value);
}

function canonicalRuntimeValue(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function assertHiddenAllowed(capability: CapabilityManifest): void {
  const commandsAreSafe = capability.commands.every((command) => hiddenRuntimeCommands.has(command))
    && invoiceCommands.every((command) => capability.commands.includes(command));
  if (
    capability.maturity !== "fast_path"
    || !capability.hiddenAllowed
    || !capability.lastValidatedVisible
    || !capability.lastValidatedAt
    || capability.testEvidence.length === 0
    || capability.realEvidence.length === 0
    || capability.runtimeScope?.kind !== "invoice"
    || capability.confirmation !== "EMITIR"
    || !commandsAreSafe
  ) {
    throw new Error(`La capacidad ${capability.id} no está habilitada para production-hidden.`);
  }
}
