import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureRuntimeLayout, RuntimePaths } from "../config/runtimePaths.js";
import { writeJsonAtomic } from "../io/atomicJson.js";
import { isValidCuit } from "../jobs/schema.js";

export const specificRegimeIds = ["meat-remit", "flour-remit", "conditioned-tobacco-remit"] as const;
export type SpecificRegimeId = typeof specificRegimeIds[number];

export const specificRegimeCatalog: Record<SpecificRegimeId, { title: string; associatedVoucherTypes: number[]; source: string }> = {
  "meat-remit": {
    title: "Remito Electrónico Cárnico",
    associatedVoucherTypes: [995],
    source: "https://www.afip.gob.ar/actividadesAgropecuarias/sector-pecuario/vinculacion-remito-factura.asp",
  },
  "flour-remit": {
    title: "Remito Electrónico Harinero",
    associatedVoucherTypes: [993, 994],
    source: "https://www.afip.gob.ar/actividadesAgropecuarias/molineria/procedimiento.asp",
  },
  "conditioned-tobacco-remit": {
    title: "Remito Electrónico de Tabaco Acondicionado",
    associatedVoucherTypes: [88],
    source: "https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf",
  },
};

const assignmentSchema = z.object({
  id: z.enum(specificRegimeIds),
  activityCode: z.string().regex(/^\d{6}$/, "El código de actividad debe contener seis dígitos."),
  validatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().url(),
});

export const issuerProfileSchema = z.object({
  schemaVersion: z.literal(1),
  issuerCuit: z.string().refine(isValidCuit, "CUIT emisor inválido."),
  specificRegimes: z.array(assignmentSchema).max(specificRegimeIds.length).superRefine((items, context) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "El régimen está repetido." });
      ids.add(item.id);
    }
  }),
});

export type IssuerProfile = z.infer<typeof issuerProfileSchema>;

export async function loadIssuerProfile(issuerCuit: string, runtime?: RuntimePaths): Promise<IssuerProfile> {
  if (!isValidCuit(issuerCuit)) throw new Error("CUIT emisor inválido.");
  const paths = runtime ?? await ensureRuntimeLayout();
  const filePath = profilePath(paths, issuerCuit);
  try {
    return issuerProfileSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, issuerCuit, specificRegimes: [] };
    throw error;
  }
}

export async function saveIssuerRegime(issuerCuit: string, id: SpecificRegimeId, activityCode: string, runtime?: RuntimePaths): Promise<IssuerProfile> {
  const paths = runtime ?? await ensureRuntimeLayout();
  const current = await loadIssuerProfile(issuerCuit, paths);
  const definition = specificRegimeCatalog[id];
  const assignment = assignmentSchema.parse({ id, activityCode, validatedAt: new Date().toISOString().slice(0, 10), source: definition.source });
  const profile = issuerProfileSchema.parse({
    ...current,
    specificRegimes: [...current.specificRegimes.filter((item) => item.id !== id), assignment],
  });
  await fs.mkdir(paths.issuers, { recursive: true });
  await writeJsonAtomic(profilePath(paths, issuerCuit), profile);
  return profile;
}

export async function removeIssuerRegime(issuerCuit: string, id: SpecificRegimeId, runtime?: RuntimePaths): Promise<IssuerProfile> {
  const paths = runtime ?? await ensureRuntimeLayout();
  const current = await loadIssuerProfile(issuerCuit, paths);
  const profile = issuerProfileSchema.parse({ ...current, specificRegimes: current.specificRegimes.filter((item) => item.id !== id) });
  await fs.mkdir(paths.issuers, { recursive: true });
  await writeJsonAtomic(profilePath(paths, issuerCuit), profile);
  return profile;
}

export async function assertInvoiceRegimeConfigured(job: { issuerKey: string; specificRegime?: string; activity?: string }, runtime?: RuntimePaths): Promise<void> {
  if (!job.specificRegime) return;
  const id = z.enum(specificRegimeIds).parse(job.specificRegime);
  const profile = await loadIssuerProfile(job.issuerKey, runtime);
  const assignment = profile.specificRegimes.find((item) => item.id === id);
  if (!assignment) throw new Error(`El emisor no tiene configurado el régimen específico ${id}.`);
  if (assignment.activityCode !== job.activity) throw new Error(`La actividad del job no coincide con el perfil privado del régimen ${id}.`);
  throw new Error(`La capacidad Factura C de servicios de un ítem no admite todavía el régimen ${id}: falta aprender y validar el comprobante asociado.`);
}

function profilePath(runtime: RuntimePaths, issuerCuit: string): string {
  return path.join(runtime.issuers, `${issuerCuit}.json`);
}
