import { loadRuntimeConfig, loadCredentials } from "./config/env.js";
import { ensureRuntimeLayout } from "./config/runtimePaths.js";
import { loadInvoiceJob } from "./jobs/schema.js";
import { runInvoiceFlow } from "./arca/runner.js";
import { parseCliArgs } from "./cliArgs.js";
import { sanitizeErrorMessage } from "./arca/publicErrors.js";

async function main(): Promise<void> {
  await ensureRuntimeLayout();
  const options = parseCliArgs(process.argv.slice(2));
  const loadedJob = await loadInvoiceJob(options.jobPath);
  const config = loadRuntimeConfig();
  const credentials = loadCredentials(loadedJob.issuerKey);
  const job = { ...loadedJob, issuerKey: credentials.issuerKey };
  await runInvoiceFlow(config, credentials, job, { guided: options.guided, dryRun: options.dryRun });
}

main().catch((error: unknown) => {
  console.error(`Error: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
