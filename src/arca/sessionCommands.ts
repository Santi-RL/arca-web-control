import { z } from "zod";
import { LearnedFlowCapability, SessionVisibilityMode } from "../types.js";

const commandSchemas = {
  status: z.object({ type: z.literal("status") }),
  snapshot: z.object({ type: z.literal("snapshot") }),
  screenshot: z.object({ type: z.literal("screenshot") }),
  pages: z.object({ type: z.literal("pages") }),
  usePage: z.object({
    type: z.literal("use-page"),
    index: z.number().int().min(0),
  }),
  selectOptions: z.object({ type: z.literal("select-options") }),
  portal: z.object({ type: z.literal("portal") }),
  openService: z.object({
    type: z.literal("open-service"),
    serviceName: z.string().trim().min(1),
  }),
  selectRepresented: z.object({
    type: z.literal("select-represented"),
    text: z.string().trim().min(1),
  }),
  inputs: z.object({ type: z.literal("inputs") }),
  prepareInvoice: z.object({
    type: z.literal("prepare-invoice"),
    jobPath: z.string().trim().min(1),
  }),
  emitPreparedInvoice: z.object({
    type: z.literal("emit-prepared-invoice"),
    preparedInvoiceId: z.string().uuid(),
    confirmation: z.literal("EMITIR"),
  }),
  savePrintPdf: z.object({
    type: z.literal("save-print-pdf"),
    outputPath: z.string().trim().min(1),
  }),
} as const;

export const sessionCommandSchema = z.discriminatedUnion("type", [
  commandSchemas.status,
  commandSchemas.snapshot,
  commandSchemas.screenshot,
  commandSchemas.pages,
  commandSchemas.usePage,
  commandSchemas.selectOptions,
  commandSchemas.portal,
  commandSchemas.openService,
  commandSchemas.selectRepresented,
  commandSchemas.inputs,
  commandSchemas.prepareInvoice,
  commandSchemas.emitPreparedInvoice,
  commandSchemas.savePrintPdf,
]);

export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export type SessionModePolicy = {
  visibilityMode: SessionVisibilityMode;
  learnedCapability?: LearnedFlowCapability;
  allowedCommands?: string[];
};

export type RedactedSessionCommand = SessionCommand;

export function parseSessionCommandArgs(argv: string[]): SessionCommand {
  if (argv.includes("--confirm-risk")) {
    throw new Error("--confirm-risk ya no está permitido. Las acciones irreversibles requieren emit-prepared-invoice y confirmación EMITIR.");
  }
  const [command, ...args] = argv;

  switch (command) {
    case "status":
    case "snapshot":
    case "screenshot":
    case "pages":
    case "inputs":
    case "select-options":
    case "portal":
      assertNoArgs(command, args);
      return { type: command };

    case "use-page": {
      const index = Number(args[0]);
      if (args.length !== 1 || !Number.isInteger(index) || index < 0) {
        throw new Error("Uso: arca:session:cmd -- use-page <indice>");
      }
      return { type: "use-page", index };
    }

    case "open-service":
      if (args.length === 0) {
        throw new Error("Uso: arca:session:cmd -- open-service <nombre-servicio>");
      }
      return { type: "open-service", serviceName: args.join(" ") };

    case "select-represented":
      if (args.length === 0) {
        throw new Error("Uso: arca:session:cmd -- select-represented <nombre-o-cuit-visible>");
      }
      return { type: "select-represented", text: args.join(" ") };

    case "prepare-invoice":
      if (args.length !== 1) {
        throw new Error("Uso: arca:session:cmd -- prepare-invoice <job-json>");
      }
      return { type: "prepare-invoice", jobPath: args[0] ?? "" };

    case "emit-prepared-invoice":
      if (args.length !== 2 || args[1] !== "EMITIR") {
        throw new Error("Uso: arca:session:cmd -- emit-prepared-invoice <preparedInvoiceId> EMITIR");
      }
      return { type: "emit-prepared-invoice", preparedInvoiceId: args[0] ?? "", confirmation: "EMITIR" };

    case "save-print-pdf":
      if (args.length === 0) {
        throw new Error("Uso: arca:session:cmd -- save-print-pdf <ruta-pdf>");
      }
      return { type: "save-print-pdf", outputPath: args.join(" ") };

    default:
      throw new Error(`Comando de sesion desconocido: ${command ?? "(vacio)"}`);
  }
}

export function assertCommandAllowedInSessionMode(command: SessionCommand, policy: SessionModePolicy): void {
  if (policy.visibilityMode === "visible") {
    return;
  }

  if (!policy.learnedCapability || !policy.allowedCommands) {
    throw new Error("El modo production-hidden requiere una capacidad habilitada por manifiesto.");
  }

  if (!policy.allowedCommands.includes(command.type)) {
    throw new Error(`El comando ${command.type} no esta permitido en modo production-hidden. Cambia a modo visible/guiado para explorar o intervenir pantallas.`);
  }
}

export function redactCommandForLog(command: SessionCommand): RedactedSessionCommand {
  return command;
}

export function extractBearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function isAuthorizedSessionRequest(headers: { authorization?: string | string[]; "x-arca-session-token"?: string | string[] }, expectedToken: string): boolean {
  const explicitHeader = Array.isArray(headers["x-arca-session-token"]) ? headers["x-arca-session-token"][0] : headers["x-arca-session-token"];
  const bearer = extractBearerToken(headers.authorization);
  return Boolean(expectedToken) && (explicitHeader === expectedToken || bearer === expectedToken);
}

function assertNoArgs(command: string, args: string[]): void {
  if (args.length > 0) {
    throw new Error(`El comando ${command} no acepta argumentos.`);
  }
}
