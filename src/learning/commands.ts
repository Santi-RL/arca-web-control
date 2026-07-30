import { z } from "zod";
import { isIrreversibleActionText, normalizeActionText } from "../arca/irreversibleActions.js";
import { isOfficialArcaPortalUrl, isOfficialArcaRcelOriginUrl } from "../arca/officialUrls.js";

export const learningCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("checkpoint"), name: z.string().min(1).max(120) }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("inspect"), pageIndex: z.number().int().min(0).max(19).optional() }),
  z.object({ type: z.literal("click-exact"), inspectionId: z.string().uuid(), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("select-exact"), inspectionId: z.string().uuid(), index: z.number().int().min(0).max(99), option: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("fill-input"), inspectionId: z.string().uuid(), index: z.number().int().min(0).max(99), value: z.string().max(2000) }),
  z.object({ type: z.literal("check-exact"), inspectionId: z.string().uuid(), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("press"), inspectionId: z.string().uuid(), key: z.enum(["Tab", "Escape"]) }),
  z.object({ type: z.literal("finish") }),
  z.object({ type: z.literal("abort") }),
]);

export type LearningCommand = z.infer<typeof learningCommandSchema>;

export function assertLearningCommandSafe(command: LearningCommand): void {
  if ((command.type === "click-exact" || command.type === "check-exact") && isIrreversibleActionText(command.text)) {
    throw new Error(`El modo aprendizaje bloquea siempre la acción irreversible: ${command.text}.`);
  }
  if (command.type === "select-exact" && isIrreversibleActionText(command.option)) {
    throw new Error(`El modo aprendizaje bloquea siempre la opción potencialmente irreversible: ${command.option}.`);
  }
}

export function normalizeLearningText(value: string): string {
  return normalizeActionText(value);
}

export function parseLearningCommandArgs(argv: string[], privateInputValue?: string): LearningCommand {
  const [operation, ...values] = argv;
  if (operation === "note") return learningCommandSchema.parse({ type: "note", text: values.join(" ") });
  if (operation === "checkpoint") return learningCommandSchema.parse({ type: "checkpoint", name: values.join(" ") });
  if (["status", "finish", "abort"].includes(operation ?? "")) {
    if (values.length) throw new Error(`El comando ${operation} no acepta argumentos.`);
    return learningCommandSchema.parse({ type: operation });
  }
  if (operation === "inspect") {
    if (values.length > 1) throw new Error("Uso: inspect [indice-pestaña]");
    return learningCommandSchema.parse({ type: operation, pageIndex: values[0] === undefined ? undefined : Number(values[0]) });
  }
  if (operation === "click-exact" || operation === "check-exact") {
    return learningCommandSchema.parse({ type: operation, inspectionId: values[0], text: values.slice(1).join(" ") });
  }
  if (operation === "select-exact") {
    const index = Number(values[1]);
    return learningCommandSchema.parse({ type: operation, inspectionId: values[0], index, option: values.slice(2).join(" ") });
  }
  if (operation === "fill-input") {
    if (values.length !== 2 || privateInputValue === undefined) throw new Error("Uso: fill-input <inspectionId> <indice>; el valor se recibe exclusivamente por stdin.");
    const index = Number(values[1]);
    return learningCommandSchema.parse({ type: operation, inspectionId: values[0], index, value: privateInputValue });
  }
  if (operation === "press") return learningCommandSchema.parse({ type: operation, inspectionId: values[0], key: values[1] });
  throw new Error("Uso: arca:learn:cmd -- note|checkpoint|status|inspect|click-exact|select-exact|fill-input|check-exact|press|finish|abort");
}

export type HybridMutation = "click" | "select" | "fill" | "check" | "press";

export function isHybridMutationAllowed(urlValue: string, action: HybridMutation): boolean {
  let url: URL;
  try { url = new URL(urlValue); } catch { return false; }
  const pathname = url.pathname.replace(/;jsessionid=[^/;?#]*/gi, "");
  if (isOfficialArcaPortalUrl(urlValue)) {
    return ["click", "fill", "press"].includes(action);
  }
  if (!isOfficialArcaRcelOriginUrl(urlValue)) return false;
  const clickPaths = [
    /^\/rcel\/jsp\/index_bis\.jsp$/i,
    /^\/rcel\/jsp\/menu_ppal\.jsp$/i,
    /^\/rcel\/jsp\/buscarPtosVtas(?:\.do)?$/i,
    /^\/rcel\/jsp\/genComDatosEmisor\.do$/i,
    /^\/rcel\/jsp\/genComDatosReceptor\.do$/i,
    /^\/rcel\/jsp\/genComDatosOperacion\.do$/i,
  ];
  if (action === "click") return clickPaths.some((pattern) => pattern.test(pathname));
  if (action === "select") return clickPaths.slice(2).some((pattern) => pattern.test(pathname));
  if (action === "fill" || action === "press") return clickPaths.slice(3).some((pattern) => pattern.test(pathname));
  return action === "check" && /^\/rcel\/jsp\/genComDatosReceptor\.do$/i.test(pathname);
}
