import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildSessionControlUrl, readCurrentSessionStateIfExists, type CurrentSessionState } from "../src/arca/sessionState.js";
import { sanitizeErrorMessage } from "../src/arca/publicErrors.js";
import { resolveCredentialRoutingIdentity } from "../src/config/env.js";
import { ensureRuntimeLayout, getRuntimePaths, useActiveSessionRuntimeLayout } from "../src/config/runtimePaths.js";
import { parseConversationalInvoiceJson } from "../src/jobs/chatIntake.js";
import { createPrivateInvoiceJob } from "../src/jobs/privateIntake.js";
import { parseChatPreparationArgs, sanitizePreparationOutput, sessionMetadataMatches, sessionStatusIsReusable } from "../src/arca/chatPreparation.js";
import { startArcaPerformance } from "../src/arca/performance.js";
import { captchaRequiredErrorFromLog, CaptchaRequiredError, isCaptchaRequiredError } from "../src/arca/captchaErrors.js";

const execFileAsync = promisify(execFile);
const maximumInputBytes = 64 * 1024;
let finishLoginToSummary: ReturnType<typeof startArcaPerformance> | undefined;

try {
  const args = parseChatPreparationArgs(process.argv.slice(2));
  const input = parseConversationalInvoiceJson(await readStandardInput());
  const runtime = await ensureRuntimeLayout(getRuntimePaths());
  const identity = resolveCredentialRoutingIdentity(input.issuerSelector);
  // La identidad durable de la intención se crea antes de abrir Chrome. Si el
  // worker cae, la capa agente reutiliza el mismo intentId y encuentra el mismo
  // job/operationId; nunca genera otro para esquivar un estado previo.
  const created = await createPrivateInvoiceJob(input, {
    privateJobsRoot: runtime.privateJobs,
    trustedRuntimeRoot: runtime.root,
    resolveIssuer: () => identity,
  });
  const currentPath = path.join(runtime.sessions, "current.json");
  let current = await reusableSession(currentPath, identity.issuerKey, args.revalidationCapability);
  if (!current) {
    finishLoginToSummary = startArcaPerformance("chat_login_to_summary");
    await startVisibleSession(identity.cuit, args.revalidationCapability, args.timeoutMs);
    current = await reusableSession(currentPath, identity.issuerKey, args.revalidationCapability);
    if (!current) throw new Error("La sesión visible se inició, pero no quedó disponible para preparar la factura.");
  }
  await useActiveSessionRuntimeLayout(runtime);

  const response = await fetch(buildSessionControlUrl(current, "/command"), {
    method: "POST",
    headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: { type: "prepare-invoice", jobPath: created.handle } }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const payload = await response.json() as Record<string, unknown>;
  const output = sanitizePreparationOutput(payload);
  const loginToSummaryMs = finishLoginToSummary?.(response.ok && output.ok === true ? "ok" : "failed");
  const structuredOutput = loginToSummaryMs === undefined
    ? output
    : { ...output, timings: { loginToSummaryMs } };
  console.log(JSON.stringify(structuredOutput, null, 2));
  if (!response.ok || output.ok !== true) process.exitCode = 2;
} catch (error) {
  finishLoginToSummary?.("failed");
  console.error(JSON.stringify({
    ok: false,
    status: "failed",
    message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
  }, null, 2));
  process.exitCode = 1;
}

async function reusableSession(currentPath: string, issuerKey: string, revalidationCapability?: string): Promise<CurrentSessionState | undefined> {
  const current = await readCurrentSessionStateIfExists(currentPath).catch(() => undefined);
  if (!current || !sessionMetadataMatches(current, issuerKey, revalidationCapability)) return undefined;
  try {
    const response = await fetch(buildSessionControlUrl(current, "/status"), {
      headers: { authorization: `Bearer ${current.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    if (sessionHasCaptcha(payload)) throw new CaptchaRequiredError();
    if (!sessionStatusIsReusable(payload)) return undefined;
    return current;
  } catch (error) {
    if (isCaptchaRequiredError(error)) throw error;
    return undefined;
  }
}

async function startVisibleSession(cuit: string, revalidationCapability: string | undefined, timeoutMs: number): Promise<void> {
  const args = ["--import", "tsx", path.resolve("scripts", "arca-session-start.mts"), "--issuer", cuit, "--timeout-ms", String(timeoutMs)];
  if (revalidationCapability) args.push("--revalidate-irreversible", revalidationCapability);
  try {
    await execFileAsync(process.execPath, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs + 15_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    const stderr = failure.stderr?.trim() || "";
    throw captchaRequiredErrorFromLog(stderr) ?? new Error(stderr || "No se pudo iniciar la sesión visible de ARCA.");
  }
}

function sessionHasCaptcha(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const state = (payload as { state?: unknown }).state;
  return typeof state === "object" && state !== null
    && ((state as { captchaVisible?: unknown }).captchaVisible === true
      || (state as { readyState?: unknown }).readyState === "captcha");
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumInputBytes) throw new Error("La entrada privada supera el límite permitido.");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("Falta la entrada privada por stdin.");
  return Buffer.concat(chunks).toString("utf8");
}
