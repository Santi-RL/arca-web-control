import path from "node:path";
import { z } from "zod";
import { isValidCuit } from "../jobs/schema.js";
import { readJsonIfExists, writeJsonAtomic } from "../io/atomicJson.js";

const uuidV4Schema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "El texto contiene caracteres de control.");

export const currentLearningStateSchema = z.object({
  version: z.literal(1),
  launchId: uuidV4Schema,
  pid: z.number().int().min(1).max(2_147_483_647),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  token: z.string().regex(/^[0-9a-f]{64}$/i),
  issuerKey: z.string().regex(/^\d{11}$/).refine(isValidCuit, "El issuerKey no es un CUIT válido."),
  issuerName: safeText(200),
  capability: z.string().regex(/^[a-z0-9-]{1,128}$/),
  intent: safeText(1_000),
  directory: z.string().trim().min(1).refine(path.isAbsolute, "La carpeta de aprendizaje debe ser absoluta."),
}).strict();

export type CurrentLearningState = z.infer<typeof currentLearningStateSchema>;

export function parseCurrentLearningState(value: unknown): CurrentLearningState {
  const parsed = currentLearningStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("El estado local de aprendizaje es inválido o fue manipulado; no se realizará ninguna conexión.");
  }
  return parsed.data;
}

export async function readCurrentLearningStateIfExists(filePath: string): Promise<CurrentLearningState | undefined> {
  let value: unknown;
  try {
    value = await readJsonIfExists<unknown>(filePath);
  } catch {
    throw new Error("El estado local de aprendizaje no contiene JSON válido; no se realizará ninguna conexión.");
  }
  return value === undefined ? undefined : parseCurrentLearningState(value);
}

export async function readCurrentLearningState(filePath: string): Promise<CurrentLearningState> {
  const current = await readCurrentLearningStateIfExists(filePath);
  if (!current) throw new Error("No hay un aprendizaje ARCA activo. Ejecutá arca:learn:start.");
  return current;
}

export async function writeCurrentLearningState(filePath: string, value: unknown): Promise<CurrentLearningState> {
  const current = parseCurrentLearningState(value);
  await writeJsonAtomic(filePath, current);
  return current;
}

export function buildLearningControlUrl(current: CurrentLearningState): string {
  // El host persistido nunca decide el destino: el control queda fijado a loopback.
  return `http://127.0.0.1:${current.port}`;
}
