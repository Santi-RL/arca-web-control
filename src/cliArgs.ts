export type CliOptions = {
  jobPath: string;
  guided: boolean;
  dryRun: boolean;
};

export function parseCliArgs(argv: string[]): CliOptions {
  const jobIndex = argv.indexOf("--job");
  const jobPath = jobIndex >= 0 ? argv[jobIndex + 1] : undefined;

  if (!jobPath) {
    throw new Error("Uso: npm run arca:invoice -- --job jobs/factura.example.json [--guided] [--dry-run]");
  }

  const guided = argv.includes("--guided");
  if (argv.includes("--allow-emit")) {
    throw new Error("arca:invoice es exclusivamente dry-run. Para emitir usá emit-prepared-invoice <preparedInvoiceId> EMITIR.");
  }

  return {
    jobPath,
    guided,
    dryRun: true,
  };
}
