import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { RuntimeConfig, ArcaCredentials, ResolvedInvoiceJob, RunInvoiceOptions } from "../types.js";
import { loginToArca } from "./login.js";
import { openComprobantesEnLinea, selectRepresentedIssuer } from "./navigation.js";
import { fillInvoice } from "./invoice.js";
import { GuidedSession } from "./guided.js";
import { FlowContext } from "./flowContext.js";
import { requireInvoiceJobCapability } from "../capabilities/registry.js";

/**
 * Ruta heredada de preparación visible. Nunca emite: la única interfaz
 * irreversible admitida es emit-prepared-invoice con un preparedInvoiceId.
 */
export async function runInvoiceFlow(
  config: RuntimeConfig,
  credentials: ArcaCredentials,
  job: ResolvedInvoiceJob,
  options: RunInvoiceOptions,
): Promise<string | undefined> {
  if (!options.dryRun) {
    throw new Error("El CLI legado no puede emitir. Usá prepare-invoice y emit-prepared-invoice <preparedInvoiceId> EMITIR.");
  }
  await requireInvoiceJobCapability(job, "prepare-invoice");
  await fs.mkdir(config.profileRoot, { recursive: true });
  const profileDir = path.join(config.profileRoot, credentials.issuerKey.replace(/[^a-zA-Z0-9_-]+/g, "_"));
  const guided = options.guided ? await GuidedSession.create() : undefined;
  const flowContext: FlowContext = {
    guided,
    strictSelectors: true,
  };

  console.log("Modo dry-run: este proceso no emitirá comprobantes.");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: config.browserChannel,
    acceptDownloads: false,
    viewport: { width: 1440, height: 900 },
  });

  let page = context.pages()[0] ?? await context.newPage();
  try {
    await loginToArca(page, config, credentials, flowContext);
    page = await openComprobantesEnLinea(page, flowContext);
    await selectRepresentedIssuer(page, credentials.cuit, credentials.displayName, flowContext);
    await fillInvoice(page, job, flowContext);
    console.log("Resumen preparado. El CLI legado finaliza sin emitir; continuá con la sesión controlada para obtener un preparedInvoiceId.");
    return undefined;
  } finally {
    await context.close();
  }
}
