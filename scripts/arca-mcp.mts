import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkpointInput, downloadInput, emitInput, learnStartInput, prepareChatInput, prepareInput, sessionStartInput, textInput } from "../src/mcp/contracts.js";
import { getRuntimePaths, useActiveSessionRuntimeLayout } from "../src/config/runtimePaths.js";
import { buildSessionControlUrl, readCurrentSessionState, type SessionControlEndpoint } from "../src/arca/sessionState.js";
import { buildLearningControlUrl, readCurrentLearningState } from "../src/learning/sessionState.js";
import { resolvePrivateInvoiceJobPath } from "../src/config/privateJobs.js";
import { runPrivateChildProcess } from "../src/io/privateChildProcess.js";
import { learningCommandTimeoutMs, loopbackHttpError, loopbackTimeoutMs, requestLoopbackJson, sessionCommandTimeoutMs } from "../src/io/loopbackRequest.js";

const runtime = getRuntimePaths();
const server = new McpServer({ name: "arca-web-control", version: "0.2.0" });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool("arca_session_start", { description: "Inicia una sesión Playwright de ARCA sin aceptar credenciales como entrada.", inputSchema: sessionStartInput }, async ({ issuerKey, productionHidden, capability }) => {
  const args = ["--issuer", issuerKey];
  if (productionHidden) args.push("--production-hidden", "--capability", capability || "");
  return result(await runScript("scripts/arca-session-start.mts", args, undefined, [0], 210_000));
});
server.registerTool("arca_session_status", { description: "Consulta el estado de la sesión ARCA actual.", inputSchema: {} }, async () => result(await sessionRequest("GET", "/status")));
server.registerTool("arca_session_stop", { description: "Cierra de forma controlada la sesión ARCA actual.", inputSchema: {} }, async () => result(await sessionRequest("POST", "/stop")));
server.registerTool("arca_prepare_invoice_chat", { description: "Recibe los datos conversacionales completos, inicia o reutiliza Chrome visible y prepara hasta el resumen sin emitir.", inputSchema: prepareChatInput }, async (input) => {
  const response = await runScript("scripts/arca-invoice-prepare-chat.mts", [], JSON.stringify(input), [0, 2], 390_000);
  return result(parseStructuredScriptOutput(response.stdout));
});
server.registerTool("arca_prepare_invoice", { description: "Carga un job v2 privado hasta el resumen, sin emitir, y devuelve preparedInvoiceId.", inputSchema: prepareInput }, async ({ jobPath }) => {
  const privateJobPath = await resolvePrivateInvoiceJobPath(jobPath, runtime.privateJobs, runtime.root);
  return result(await sessionCommand({ type: "prepare-invoice", jobPath: privateJobPath }));
});
server.registerTool("arca_emit_prepared_invoice", { description: "Contrato reservado para una futura capacidad promovida. El manifiesto vigente bloquea toda emisión, incluso con EMITIR.", inputSchema: emitInput }, async ({ preparedInvoiceId, confirmation }) => result(await sessionCommand({ type: "emit-prepared-invoice", preparedInvoiceId, confirmation })));
server.registerTool("arca_download_pdf", { description: "Contrato reservado para una futura capacidad promovida. Solo podrá guardar un PDF dentro de downloads cuando un manifiesto vigente lo habilite.", inputSchema: downloadInput }, async ({ outputPath }) => result(await sessionCommand({ type: "save-print-pdf", outputPath })));
server.registerTool("arca_learn_start", { description: "Inicia aprendizaje visible; si el login exige captcha conserva Chrome y devuelve una pausa explícita.", inputSchema: learnStartInput }, async ({ issuerKey, capability, intent }) => result(await runScript("scripts/arca-learn-start.mts", ["--issuer", issuerKey, "--capability", capability, "--intent", intent], undefined, [0, 2], 315_000)));
server.registerTool("arca_learn_resume_authentication", { description: "Reanuda la autenticación del aprendizaje en la misma sesión visible, solo después de una intervención humana por captcha.", inputSchema: {} }, async () => result(await learningCommand({ type: "resume-authentication" })));
server.registerTool("arca_learn_note", { description: "Agrega una nota privada, no anonimizada automáticamente, al aprendizaje actual; no debe contener datos reales ni secretos.", inputSchema: textInput }, async ({ text }) => result(await learningCommand({ type: "note", text })));
server.registerTool("arca_learn_checkpoint", { description: "Captura un checkpoint privado; su nombre no debe contener datos reales ni secretos.", inputSchema: checkpointInput }, async ({ name }) => result(await learningCommand({ type: "checkpoint", name })));
server.registerTool("arca_learn_finish", { description: "Finaliza el aprendizaje como candidato no productivo.", inputSchema: {} }, async () => result(await learningCommand({ type: "finish" })));

await server.connect(new StdioServerTransport());

async function runScript(script: string, args: string[], stdin?: string, acceptedExitCodes: readonly number[] = [0], timeoutMs = 300_000): Promise<{ stdout: string; exitCode: number }> {
  return await runPrivateChildProcess(
    process.execPath,
    [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), path.resolve(script), ...args],
    { stdin, acceptedExitCodes, timeoutMs },
  );
}

async function sessionCommand(command: unknown): Promise<unknown> {
  await useActiveSessionRuntimeLayout(runtime);
  return sessionRequest("POST", "/command", { command }, sessionCommandTimeoutMs(command));
}
async function sessionRequest(method: "GET" | "POST", endpoint: SessionControlEndpoint, body?: unknown, timeoutMs?: number): Promise<unknown> {
  const current = await readCurrentSessionState(path.join(runtime.sessions, "current.json"));
  const response = await requestLoopbackJson(buildSessionControlUrl(current, endpoint), {
    label: endpoint === "/status" ? "el estado de la sesión" : endpoint === "/stop" ? "el cierre de la sesión" : "el comando de sesión",
    timeoutMs: timeoutMs ?? (endpoint === "/status" ? loopbackTimeoutMs.diagnostic : endpoint === "/stop" ? loopbackTimeoutMs.stop : loopbackTimeoutMs.mutation),
    mutation: endpoint !== "/status",
    init: { method, headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
  });
  if (!response.ok) throw loopbackHttpError("la solicitud de sesión", response);
  return response.payload;
}
async function learningCommand(command: unknown): Promise<unknown> {
  await useActiveSessionRuntimeLayout(runtime);
  const current = await readCurrentLearningState(path.join(runtime.learning, "current.json"));
  const response = await requestLoopbackJson(buildLearningControlUrl(current), {
    label: `el comando de aprendizaje`,
    timeoutMs: learningCommandTimeoutMs(command),
    mutation: !["status", "inspect"].includes(typeof command === "object" && command !== null ? String((command as { type?: unknown }).type ?? "") : ""),
    init: { method: "POST", headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: JSON.stringify(command) },
  });
  if (!response.ok) throw loopbackHttpError("el comando de aprendizaje", response);
  return response.payload;
}

function parseStructuredScriptOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("El comando local no devolvió una respuesta JSON válida.");
  }
}
