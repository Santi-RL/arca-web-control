import path from "node:path";
import { z } from "zod";
import { readJsonIfExists, writeJsonAtomic } from "../io/atomicJson.js";
import { isValidCuit } from "../jobs/schema.js";

const processIdSchema = z.number().int().min(1).max(2_147_483_647);
const sessionTokenSchema = z.string().regex(/^[0-9a-f]{64}$/, "El token local de sesión debe ser hexadecimal y tener 256 bits.");
const capabilityIdSchema = z.string().regex(/^[a-z0-9-]{1,128}$/);
const issuerKeySchema = z.string().regex(/^\d{11}$/).refine(isValidCuit, "El issuerKey no es un CUIT válido.");
const timestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, "La fecha de inicio debe ser un timestamp ISO UTC canónico.");
const absolutePathSchema = z.string().trim().min(1).refine(path.isAbsolute, "La ruta de artefactos debe ser absoluta.");
const visibilityModeSchema = z.enum(["visible", "production-hidden"]);

const liveSessionStateSchema = z.object({
  issuerKey: issuerKeySchema,
  url: z.string().min(1).max(2_048),
  title: z.string().max(1_000),
  readyState: z.enum(["portal", "service", "selector_emisor", "rcel_menu", "auth", "captcha", "expired", "forbidden", "otro"]),
  captchaVisible: z.boolean(),
  pageCount: z.number().int().min(1).max(100),
  artifactDir: absolutePathSchema,
  visibilityMode: visibilityModeSchema,
  learnedCapability: capabilityIdSchema.optional(),
}).strict();

export const currentSessionStateSchema = z.object({
  version: z.literal(2),
  pid: processIdSchema,
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  token: sessionTokenSchema,
  issuerKey: issuerKeySchema,
  issuerName: z.string().trim().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "El nombre del emisor contiene caracteres de control."),
  visibilityMode: visibilityModeSchema,
  learnedCapability: capabilityIdSchema.optional(),
  artifactDir: absolutePathSchema,
  startedAt: timestampSchema,
  handoffComplete: z.boolean(),
  state: liveSessionStateSchema,
}).strict().superRefine((current, context) => {
  if (current.state.issuerKey !== current.issuerKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", "issuerKey"], message: "El CUIT del estado no coincide con la sesión." });
  }
  if (current.state.visibilityMode !== current.visibilityMode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", "visibilityMode"], message: "La visibilidad del estado no coincide con la sesión." });
  }
  if (current.state.learnedCapability !== current.learnedCapability) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", "learnedCapability"], message: "La capacidad del estado no coincide con la sesión." });
  }
  if (!samePath(current.state.artifactDir, current.artifactDir)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", "artifactDir"], message: "La ruta de artefactos del estado no coincide con la sesión." });
  }
  if (current.visibilityMode === "production-hidden" && !current.learnedCapability) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["learnedCapability"], message: "production-hidden requiere una capacidad declarada." });
  }
});

export type CurrentSessionState = z.infer<typeof currentSessionStateSchema>;
export type SessionControlEndpoint = "/status" | "/stop" | "/command";

export function parseCurrentSessionState(value: unknown): CurrentSessionState {
  const parsed = currentSessionStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("El estado local de sesión es inválido o fue manipulado; no se realizará ninguna conexión.");
  }
  return parsed.data;
}

export async function readCurrentSessionStateIfExists(filePath: string): Promise<CurrentSessionState | undefined> {
  let value: unknown;
  try {
    value = await readJsonIfExists<unknown>(filePath);
  } catch {
    throw new Error("El estado local de sesión no contiene JSON válido; no se realizará ninguna conexión.");
  }
  return value === undefined ? undefined : parseCurrentSessionState(value);
}

export async function readCurrentSessionState(filePath: string): Promise<CurrentSessionState> {
  const current = await readCurrentSessionStateIfExists(filePath);
  if (!current) throw new Error("No hay una sesión ARCA activa. Ejecutá arca:session:start.");
  return current;
}

export async function writeCurrentSessionState(filePath: string, value: unknown): Promise<CurrentSessionState> {
  const current = parseCurrentSessionState(value);
  await writeJsonAtomic(filePath, current);
  return current;
}

export function buildSessionControlUrl(current: CurrentSessionState, endpoint: SessionControlEndpoint): string {
  // El host no se toma del archivo: incluso tras validarlo, el destino queda fijado al loopback literal.
  return `http://127.0.0.1:${current.port}${endpoint}`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}
