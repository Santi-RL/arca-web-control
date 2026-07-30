import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkpointInput, downloadInput, emitInput, learnStartInput, prepareInput, sessionStartInput, textInput } from "../src/mcp/contracts.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";
import { buildSessionControlUrl, readCurrentSessionState, type SessionControlEndpoint } from "../src/arca/sessionState.js";
import { buildLearningControlUrl, readCurrentLearningState } from "../src/learning/sessionState.js";
import { resolvePrivateInvoiceJobPath } from "../src/config/privateJobs.js";

const runtime = getRuntimePaths();
const server = new McpServer({ name: "arca-web-control", version: "0.2.0" });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool("arca_session_start", { description: "Inicia una sesión Playwright de ARCA sin aceptar credenciales como entrada.", inputSchema: sessionStartInput }, async ({ issuerKey, productionHidden, capability }) => {
  const args = ["--issuer", issuerKey];
  if (productionHidden) args.push("--production-hidden", "--capability", capability || "");
  return result(await runScript("scripts/arca-session-start.mts", args));
});
server.registerTool("arca_session_status", { description: "Consulta el estado de la sesión ARCA actual.", inputSchema: {} }, async () => result(await sessionRequest("GET", "/status")));
server.registerTool("arca_session_stop", { description: "Cierra de forma controlada la sesión ARCA actual.", inputSchema: {} }, async () => result(await sessionRequest("POST", "/stop")));
server.registerTool("arca_prepare_invoice", { description: "Carga un job v2 privado hasta el resumen, sin emitir, y devuelve preparedInvoiceId.", inputSchema: prepareInput }, async ({ jobPath }) => {
  const privateJobPath = await resolvePrivateInvoiceJobPath(jobPath, runtime.privateJobs, runtime.root);
  return result(await sessionCommand({ type: "prepare-invoice", jobPath: privateJobPath }));
});
server.registerTool("arca_emit_prepared_invoice", { description: "Contrato reservado para una futura capacidad promovida. El manifiesto vigente bloquea toda emisión, incluso con EMITIR.", inputSchema: emitInput }, async ({ preparedInvoiceId, confirmation }) => result(await sessionCommand({ type: "emit-prepared-invoice", preparedInvoiceId, confirmation })));
server.registerTool("arca_download_pdf", { description: "Contrato reservado para una futura capacidad promovida. Solo podrá guardar un PDF dentro de downloads cuando un manifiesto vigente lo habilite.", inputSchema: downloadInput }, async ({ outputPath }) => result(await sessionCommand({ type: "save-print-pdf", outputPath })));
server.registerTool("arca_learn_start", { description: "Inicia aprendizaje visible después del login; nunca habilita producción automáticamente.", inputSchema: learnStartInput }, async ({ issuerKey, capability, intent }) => result(await runScript("scripts/arca-learn-start.mts", ["--issuer", issuerKey, "--capability", capability, "--intent", intent])));
server.registerTool("arca_learn_note", { description: "Agrega una nota privada, no anonimizada automáticamente, al aprendizaje actual; no debe contener datos reales ni secretos.", inputSchema: textInput }, async ({ text }) => result(await learningCommand({ type: "note", text })));
server.registerTool("arca_learn_checkpoint", { description: "Captura un checkpoint privado; su nombre no debe contener datos reales ni secretos.", inputSchema: checkpointInput }, async ({ name }) => result(await learningCommand({ type: "checkpoint", name })));
server.registerTool("arca_learn_finish", { description: "Finaliza el aprendizaje como candidato no productivo.", inputSchema: {} }, async () => result(await learningCommand({ type: "finish" })));

await server.connect(new StdioServerTransport());

async function runScript(script: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), path.resolve(script), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => code === 0 ? resolve({ stdout: stdout.trim() }) : reject(new Error(stderr.trim() || `El comando terminó con código ${code}.`)));
  });
}

async function sessionCommand(command: unknown): Promise<unknown> { return sessionRequest("POST", "/command", { command }); }
async function sessionRequest(method: "GET" | "POST", endpoint: SessionControlEndpoint, body?: unknown): Promise<unknown> {
  const current = await readCurrentSessionState(path.join(runtime.sessions, "current.json"));
  const response = await fetch(buildSessionControlUrl(current, endpoint), { method, headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json(); if (!response.ok) throw new Error(JSON.stringify(payload)); return payload;
}
async function learningCommand(command: unknown): Promise<unknown> {
  const current = await readCurrentLearningState(path.join(runtime.learning, "current.json"));
  const response = await fetch(buildLearningControlUrl(current), { method: "POST", headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" }, body: JSON.stringify(command) });
  const payload = await response.json(); if (!response.ok) throw new Error(JSON.stringify(payload)); return payload;
}
