import { createPrivateInvoiceJob } from "../src/jobs/privateIntake.js";
import { resolveCredentialRoutingIdentity } from "../src/config/env.js";
import { ensureRuntimeLayout, getRuntimePaths } from "../src/config/runtimePaths.js";
import { sanitizeErrorMessage } from "../src/arca/publicErrors.js";

const maximumInputBytes = 64 * 1024;

try {
  const raw = await readStandardInput();
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("La entrada privada no contiene un JSON válido.");
  }
  const runtime = await ensureRuntimeLayout(getRuntimePaths());
  const created = await createPrivateInvoiceJob(input, {
    privateJobsRoot: runtime.privateJobs,
    trustedRuntimeRoot: runtime.root,
    resolveIssuer: resolveCredentialRoutingIdentity,
  });
  console.log("JOB_CREATED=1");
  console.log(`JOB_HANDLE=${created.handle}`);
  console.log(`OPERATION_ID=${created.operationId}`);
} catch (error) {
  console.error("JOB_CREATED=0");
  console.error(sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
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
