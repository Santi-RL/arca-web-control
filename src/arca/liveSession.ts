import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, Locator, Page } from "playwright";
import { ArcaCredentials, LearnedFlowCapability, ResolvedInvoiceJob, RuntimeConfig, SessionVisibilityMode } from "../types.js";
import { parseInvoiceJobJson } from "../jobs/schema.js";
import { formatDateForArca } from "../utils/date.js";
import { isCaptchaVisible } from "./captcha.js";
import { CaptchaRequiredError, isCaptchaRequiredError } from "./captchaErrors.js";
import { AuthenticationAttemptGate } from "./authenticationAttemptGate.js";
import { fillInvoice } from "./invoice.js";
import { continueArcaAccessIfRequested, loginToArca } from "./login.js";
import { InvalidArcaCredentialsError } from "./loginErrors.js";
import { openArcaService, openComprobantesEnLinea, selectRepresentedIssuer } from "./navigation.js";
import { waitForPageSettled } from "./pageHelpers.js";
import { assertCommandAllowedInSessionMode, redactCommandForLog, SessionCommand } from "./sessionCommands.js";
import { FlowContext } from "./flowContext.js";
import { InvoiceControlEvidence } from "./controlEvidence.js";
import { executeControlledEmission, sha256File } from "./emission.js";
import { OperationLedger } from "./operationLedger.js";
import { fingerprintPage, hashCanonicalJob, PreparedInvoiceState, PreparedInvoiceStore, PreparedInvoiceSummary } from "./preparedInvoice.js";
import { invalidatePreparationBeforeMutation } from "./preparationLifecycle.js";
import { PdfDestinationReservation, reservePrivatePdfDestination, resolveRuntimePdfPath } from "../config/privateDownloads.js";
import { getRuntimePaths } from "../config/runtimePaths.js";
import { readPrivateInvoiceJobFile } from "../config/privateJobs.js";
import { resolveCredentialRoutingIdentity } from "../config/env.js";
import { measureArcaPerformance, startArcaPerformance } from "./performance.js";
import { downloadGeneratedInvoicePdf, inspectArcaInvoicePdf, type ArcaInvoicePdfEvidence } from "./invoicePdf.js";
import { sanitizeErrorMessage } from "./publicErrors.js";
import { requireHiddenCapability, requireInvoiceJobCapability, requireInvoiceJobVisibleRevalidation, requireVisibleInvoiceRevalidationCapability } from "../capabilities/registry.js";
import {
  assertOfficialArcaGeneratedInvoicePageUrl,
  assertOfficialArcaInspectableUrl,
  assertOfficialArcaRcelUrl,
  isOfficialArcaAuthUrl,
  isOfficialArcaInspectableUrl,
  isOfficialArcaPortalOriginUrl,
  isOfficialArcaPortalUrl,
  isOfficialArcaRcelOriginUrl,
  isOfficialArcaRcelUrl,
  sanitizeArcaUrlForOutput,
} from "./officialUrls.js";
import { commercialAddressesMatch } from "./recipientCommercialAddress.js";
import { assertIssuerEvidenceMatches, extractIssuerSummaryEvidence } from "./issuerEvidence.js";
import { buildInvoiceStagingPdfPath, publishInvoiceArtifactsForJob } from "./invoiceArchive.js";
import { assertVisibleRevalidationAvailable, claimVisibleRevalidation, releaseVisibleRevalidationBeforeFirstClick } from "./visibleRevalidationGuard.js";
import { prepareSessionPrivatePaths } from "./sessionPrivatePaths.js";

const portalUrl = "https://portalcf.cloud.afip.gob.ar/portal/app/";

export type ArcaLiveSessionOptions = {
  issuerKey: string;
  config: RuntimeConfig;
  credentials: ArcaCredentials;
  artifactRoot?: string;
  visibilityMode?: SessionVisibilityMode;
  learnedCapability?: LearnedFlowCapability;
  revalidationCapability?: LearnedFlowCapability;
  allowedCommands?: string[];
  startupSignal?: AbortSignal;
};

type ResolvedArcaLiveSessionOptions = {
  issuerKey: string;
  config: RuntimeConfig;
  credentials: ArcaCredentials;
  artifactRoot: string;
  visibilityMode: SessionVisibilityMode;
  learnedCapability?: LearnedFlowCapability;
  revalidationCapability?: LearnedFlowCapability;
  allowedCommands?: string[];
  startupSignal?: AbortSignal;
};

export type ArcaLiveSessionState = {
  issuerKey: string;
  url: string;
  title: string;
  readyState: "portal" | "service" | "selector_emisor" | "rcel_menu" | "auth" | "captcha" | "expired" | "forbidden" | "otro";
  captchaVisible: boolean;
  pageCount: number;
  artifactDir: string;
  visibilityMode: SessionVisibilityMode;
  learnedCapability?: LearnedFlowCapability;
  revalidationCapability?: LearnedFlowCapability;
  revalidationConsumed: boolean;
};

export type ArcaLiveSessionResult = {
  ok: boolean;
  status: "ok" | "needs_manual_intervention" | "error";
  message?: string;
  state: ArcaLiveSessionState;
  data?: unknown;
};

export class ArcaLiveSession {
  private readonly preparedInvoices = new PreparedInvoiceStore();
  private readonly ledger = new OperationLedger();
  private revalidationConsumed = false;
  private readonly authenticationAttempts = new AuthenticationAttemptGate();

  private constructor(
    private page: Page,
    private readonly context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
    private readonly options: ResolvedArcaLiveSessionOptions,
  ) {}

  static async create(options: ArcaLiveSessionOptions): Promise<ArcaLiveSession> {
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    let startupAborted = options.startupSignal?.aborted ?? false;
    const abortStartup = () => {
      startupAborted = true;
      void context?.close().catch(() => undefined);
    };
    const throwIfStartupAborted = () => {
      if (startupAborted) throw new Error("Inicio de sesión cancelado durante el arranque del navegador.");
    };
    options.startupSignal?.addEventListener("abort", abortStartup, { once: true });

    try {
      throwIfStartupAborted();
      const visibilityMode = options.visibilityMode ?? "visible";
      if (visibilityMode === "production-hidden") {
        if (!options.learnedCapability) throw new Error("production-hidden requiere una capacidad registrada.");
        await requireHiddenCapability(options.learnedCapability);
      }
      if (options.revalidationCapability) {
        if (visibilityMode !== "visible" || options.learnedCapability) {
          throw new Error("La revalidación irreversible exige una sesión visible exclusiva, sin production-hidden ni otra capacidad.");
        }
        const capability = await requireVisibleInvoiceRevalidationCapability(options.revalidationCapability);
        await assertVisibleRevalidationAvailable(capability);
      }
      const { artifactDir, profileDir } = await prepareSessionPrivatePaths({
        config: options.config,
        issuerKey: options.issuerKey,
        artifactName: timestampForPath(),
        artifactRoot: options.artifactRoot,
      });
      throwIfStartupAborted();

      context = await measureArcaPerformance("browser_launch", async () => await chromium.launchPersistentContext(profileDir, {
          headless: visibilityMode === "production-hidden",
          channel: options.config.browserChannel,
          acceptDownloads: true,
          viewport: { width: 1440, height: 900 },
          timeout: 15_000,
        }));
      throwIfStartupAborted();

      const page = context.pages()[0] ?? await context.newPage();
      throwIfStartupAborted();
      const session = new ArcaLiveSession(page, context, {
        ...options,
        artifactRoot: artifactDir,
        visibilityMode,
      });

      try {
        await measureArcaPerformance("login_total", async () => await loginToArca(session.page, options.config, options.credentials, {
            strictSelectors: true,
            interactive: visibilityMode === "visible",
            // La sesión canónica corre desacoplada con stdin=ignore. Nunca debe
            // intentar resolver una pausa conversacional mediante readline.
            manualIntervention: false,
          }));
      } catch (error) {
        if (!isCaptchaRequiredError(error) || visibilityMode !== "visible") throw error;
        throwIfStartupAborted();
        session.authenticationAttempts.markCaptchaRequired();
        await session.page.bringToFront().catch(() => undefined);
        await session.writeSessionEvent("session_paused_for_captcha", { state: await session.getState() }).catch(() => undefined);
        return session;
      }
      throwIfStartupAborted();
      if (visibilityMode === "visible") {
        await session.page.bringToFront().catch(() => undefined);
      }
      await session.writeSessionEvent("session_started", { state: await session.getState() });
      throwIfStartupAborted();
      return session;
    } catch (error) {
      await context?.close().catch(() => undefined);
      throw error;
    } finally {
      options.startupSignal?.removeEventListener("abort", abortStartup);
    }
  }
  get artifactDir(): string {
    return this.options.artifactRoot;
  }

  async close(): Promise<void> {
    try {
      const state = await this.getState().catch(() => undefined);
      await this.invalidateActivePreparation(
        "La sesión se cerró antes de emitir.",
        this.authenticationAttempts.isPausedForCaptcha() || isRecognizedPreClickInterruption(state?.readyState),
      );
    } finally {
      await this.context.close().catch(() => undefined);
    }
  }

  async execute(command: SessionCommand): Promise<ArcaLiveSessionResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    let result: ArcaLiveSessionResult;
    const finishConfirmationToPdf = isIrreversibleCommand(command)
      ? startArcaPerformance("emission_confirmation_to_pdf")
      : undefined;

    try {
      assertCommandAllowedInSessionMode(command, {
        visibilityMode: this.options.visibilityMode,
        learnedCapability: this.options.learnedCapability,
        revalidationCapability: this.options.revalidationCapability,
        revalidationConsumed: this.revalidationConsumed,
        allowedCommands: this.options.allowedCommands,
      });
      if (!isReadOnlyCommand(command) && command.type !== "resume-authentication") {
        this.authenticationAttempts.assertMutationAllowed();
      }
      const readOnly = isReadOnlyCommand(command);
      const stateBeforeCommand = readOnly ? undefined : await this.getState();
      if (invalidatesPreparation(command.type)) {
        await this.invalidateActivePreparation(
          `La preparación fue invalidada por el comando ${command.type}.`,
          command.type === "resume-authentication" || isRecognizedPreClickInterruption(stateBeforeCommand?.readyState),
        );
      }
      if (stateBeforeCommand?.readyState === "expired" || stateBeforeCommand?.readyState === "forbidden") {
        result = await this.manualIntervention(stateBeforeCommand.readyState === "expired"
          ? "La sesión de Clave Fiscal expiró. No se reintentará el comando; iniciá una autenticación nueva."
          : "ARCA respondió Forbidden. No se reintentará el comando; verificá el Portal de Clave Fiscal y renová la sesión si expiró.");
      } else if (!readOnly && await isCaptchaVisible(this.page)) {
        this.authenticationAttempts.markCaptchaRequired();
        const message = this.options.visibilityMode === "production-hidden"
          ? "ARCA está solicitando captcha. La sesión está en modo production-hidden; reiniciá en modo visible para resolverlo manualmente."
          : "ARCA está solicitando captcha. Completalo manualmente en el navegador y reintentá el comando.";
        result = await this.manualIntervention(message);
      } else {
        result = await this.executeUnsafe(command, () => finishConfirmationToPdf?.("ok"));
      }
    } catch (error) {
      if (isCaptchaRequiredError(error)) this.authenticationAttempts.markCaptchaRequired();
      if (error instanceof InvalidArcaCredentialsError) this.authenticationAttempts.markRejected();
      result = isCaptchaRequiredError(error) && !isIrreversibleCommand(command)
        ? await this.manualIntervention(new CaptchaRequiredError().message)
        : {
            ok: false,
            status: "error",
            message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
            state: await this.getState(),
          };
    }

    finishConfirmationToPdf?.("failed");
    await this.appendCommandLog(command, result, startedAt, Date.now() - start);
    return result;
  }

  async getState(): Promise<ArcaLiveSessionState> {
    const currentUrl = this.page.url();
    const inspectable = isOfficialArcaInspectableUrl(currentUrl);
    const title = inspectable ? await this.page.title().catch(() => "") : "";
    const body = inspectable ? await this.page.locator("body").innerText({ timeout: 1500 }).catch(() => "") : "";
    const captchaVisible = inspectable ? await isCaptchaVisible(this.page) : false;
    const remainedInspectable = inspectable && isStableInspectablePageUrl(currentUrl, this.page.url());

    return {
      issuerKey: this.options.issuerKey,
      url: remainedInspectable ? sanitizeArcaUrlForOutput(currentUrl) : "[página-no-ARCA]",
      title: remainedInspectable ? title : "",
      readyState: remainedInspectable ? (captchaVisible ? "captcha" : classifyReadyState(currentUrl, title, body)) : "otro",
      captchaVisible: remainedInspectable ? captchaVisible : false,
      pageCount: this.context.pages().length,
      artifactDir: this.artifactDir,
      visibilityMode: this.options.visibilityMode,
      learnedCapability: this.options.learnedCapability,
      revalidationCapability: this.options.revalidationCapability,
      revalidationConsumed: this.revalidationConsumed,
    };
  }

  private async executeUnsafe(command: SessionCommand, onPdfObtained?: () => number | undefined): Promise<ArcaLiveSessionResult> {
    switch (command.type) {
      case "status":
        return this.ok(await this.getState());

      case "snapshot":
        return this.ok(await this.getState(), { snapshot: await this.snapshot() });

      case "screenshot":
        return this.ok(await this.getState(), { screenshotPath: await this.screenshot() });

      case "pages":
        return this.ok(await this.getState(), { pages: await this.pages() });

      case "use-page":
        await this.usePage(command.index);
        return this.ok(await this.getState(), { message: `Pestana activa cambiada a indice ${command.index}.` });

      case "select-options":
        return this.ok(await this.getState(), { selects: await this.selectOptions() });

      case "inputs":
        return this.ok(await this.getState(), { inputs: await this.inputs() });

      case "resume-authentication":
        return await this.resumeAuthentication();

      case "portal":
        await this.goPortal();
        return this.afterNavigationResult("Portal de Clave Fiscal abierto.");

      case "open-service":
        await this.openService(command.serviceName);
        return this.afterNavigationResult(`Servicio abierto: ${command.serviceName}.`);

      case "select-represented":
        await this.selectRepresented(command.text);
        await waitForPageSettled(this.page);
        return this.afterNavigationResult(`Representado seleccionado: ${command.text}.`);

      case "prepare-invoice": {
        const data = await this.prepareInvoice(command.jobPath);
        return this.ok(await this.getState(), data);
      }

      case "emit-prepared-invoice": {
        const data = await this.emitPreparedInvoice(command.preparedInvoiceId, false, onPdfObtained);
        return this.ok(await this.getState(), data);
      }

      case "revalidate-prepared-invoice": {
        const data = await this.emitPreparedInvoice(command.preparedInvoiceId, true, onPdfObtained);
        return this.ok(await this.getState(), data);
      }

      case "save-print-pdf":
        return this.ok(await this.getState(), { pdfPath: await this.savePrintPdf(resolveRuntimePdfPath(command.outputPath), getRuntimePaths().downloads, getRuntimePaths().root) });

    }
  }

  private async afterNavigationResult(message: string): Promise<ArcaLiveSessionResult> {
    await waitForPageSettled(this.page);
    await this.adoptNewestPage();

    if (await isCaptchaVisible(this.page)) {
      this.authenticationAttempts.markCaptchaRequired();
      return this.manualIntervention("ARCA está solicitando captcha. Completalo manualmente en el navegador y reintentá el comando.");
    }

    return this.ok(await this.getState(), { message });
  }

  private async ok(state: ArcaLiveSessionState, data?: unknown): Promise<ArcaLiveSessionResult> {
    return {
      ok: true,
      status: "ok",
      state,
      data,
    };
  }

  private async manualIntervention(message: string): Promise<ArcaLiveSessionResult> {
    return {
      ok: false,
      status: "needs_manual_intervention",
      message,
      state: await this.getState(),
    };
  }

  private async resumeAuthentication(): Promise<ArcaLiveSessionResult> {
    if (this.options.visibilityMode !== "visible") {
      throw new Error("resume-authentication solo se admite en una sesión visible.");
    }
    this.authenticationAttempts.assertResumeAllowed();

    const initialState = await this.getState();
    if (initialState.captchaVisible) {
      return this.manualIntervention(new CaptchaRequiredError().message);
    }
    if (initialState.readyState === "portal") {
      this.authenticationAttempts.markResumed();
      await this.writeSessionEvent("authentication_resumed_manually", { state: initialState }).catch(() => undefined);
      return this.ok(initialState, { message: "La sesión ya está autenticada; no se reenvió ningún formulario." });
    }
    if (initialState.readyState !== "auth") {
      return this.manualIntervention("La pantalla visible no es el login oficial esperado. No se reenvió ningún formulario.");
    }

    try {
      await continueArcaAccessIfRequested(this.page, this.options.credentials, {
        strictSelectors: true,
        interactive: true,
        manualIntervention: false,
      });
    } catch (error) {
      if (error instanceof InvalidArcaCredentialsError) this.authenticationAttempts.markRejected();
      throw error;
    }

    const finalState = await this.getState();
    if (finalState.captchaVisible) {
      return this.manualIntervention(new CaptchaRequiredError().message);
    }
    if (finalState.readyState !== "portal") {
      return this.manualIntervention("ARCA no confirmó el Portal de Clave Fiscal después de la reanudación explícita. No se hará otro intento.");
    }
    this.authenticationAttempts.markResumed();
    await this.writeSessionEvent("authentication_resumed", { state: finalState }).catch(() => undefined);
    return this.ok(finalState, { message: "Autenticación reanudada en la misma sesión visible." });
  }

  private async goPortal(): Promise<void> {
    await this.page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(this.page);
    await this.page.bringToFront().catch(() => undefined);
  }

  private async adoptNewestPage(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pages = this.context.pages();
      for (const candidatePage of [...pages].reverse()) {
        if (candidatePage.isClosed()) {
          continue;
        }

        const url = candidatePage.url();
        if (url === "about:blank") {
          continue;
        }

        if (isOfficialArcaRcelOriginUrl(url) && !isOfficialArcaRcelUrl(url)) {
          throw new Error("ARCA_UNTRUSTED_RCEL_PAGE: RCEL abrió una ruta que no está aprobada; no se adoptó la pestaña.");
        }

        if (candidatePage === this.page) {
          return;
        }

        if (candidatePage !== this.page && isOfficialArcaRcelUrl(url)) {
          this.page = candidatePage;
          await this.page.bringToFront().catch(() => undefined);
          await waitForPageSettled(this.page);
          assertOfficialArcaRcelUrl(this.page.url(), "la adopción de la pestaña RCEL");
          return;
        }
      }

      await this.page.waitForTimeout(250);
    }
  }

  private async openService(serviceName: string): Promise<void> {
    this.page = await openArcaService(this.page, serviceName, this.options.config, this.options.credentials);
  }

  private async selectRepresented(text: string): Promise<void> {
    assertOfficialArcaRcelUrl(this.page.url(), "la lectura del representado");
    const heading = this.page.getByText(/representar a:|empresa a representar/i).first();
    const headingBox = await heading.boundingBox().catch(() => null);
    if (!headingBox) {
      throw new Error("No se encontro la seccion de empresa a representar.");
    }

    const locator = this.page.getByText(new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`, "i"));
    const total = await locator.count().catch(() => 0);
    const visibleBelowHeading: Locator[] = [];

    for (let index = 0; index < Math.min(total, 25); index += 1) {
      const current = locator.nth(index);
      const box = await current.boundingBox().catch(() => null);
      if (box && box.y > headingBox.y + headingBox.height) {
        visibleBelowHeading.push(current);
      }
    }

    if (visibleBelowHeading.length === 0) {
      throw new Error(`No se encontro representado visible debajo de REPRESENTAR A para "${text}".`);
    }

    if (visibleBelowHeading.length > 1) {
      throw new Error(`Selector ambiguo para representado "${text}": ${visibleBelowHeading.length} elementos visibles debajo de REPRESENTAR A.`);
    }

    assertOfficialArcaRcelUrl(this.page.url(), "la selección del representado");
    await (visibleBelowHeading[0] as Locator).click();
  }

  private async prepareInvoice(jobPath: string): Promise<{ message: string; capabilityId: string; preparedInvoiceId: string; expiresAt: string; summary: PreparedInvoiceSummary; screenshotPath: string }> {
    const { job, jobHash, capabilityId, preparedInvoiceId } = await measureArcaPerformance("prepare_preflight", async () => {
      const runtime = getRuntimePaths();
      const privateJob = await readPrivateInvoiceJobFile(jobPath, runtime.privateJobs, runtime.root);
      const loadedJob = parseInvoiceJobJson(privateJob.contents, privateJob.path);
      const capability = await requireInvoiceJobCapability(loadedJob, "prepare-invoice", {
        capabilityId: this.options.learnedCapability ?? this.options.revalidationCapability,
        requireHidden: this.options.visibilityMode === "production-hidden",
      });
      const jobIdentity = resolveCredentialRoutingIdentity(loadedJob.issuerKey);
      if (jobIdentity.issuerKey !== this.options.issuerKey) {
        throw new Error(`El job pertenece al CUIT ${jobIdentity.cuit}, pero la sesión activa corresponde a otro contribuyente.`);
      }
      const resolvedJob = { ...loadedJob, issuerKey: jobIdentity.issuerKey };
      assertFastInvoiceJob(resolvedJob);
      return {
        job: resolvedJob,
        jobHash: hashCanonicalJob(resolvedJob),
        capabilityId: capability.id,
        preparedInvoiceId: randomUUID(),
      };
    });
    await measureArcaPerformance("prepare_ensure_rcel_menu", async () => await this.ensureRcelMenu());
    await measureArcaPerformance("prepare_ledger_claim", async () => await this.ledger.claimPreparation(job.operationId, jobHash, preparedInvoiceId));
    try {
      const flowContext: FlowContext = {
        strictSelectors: true,
        interactive: false,
        manualIntervention: false,
      };
      const evidence = await fillInvoice(this.page, job, flowContext);
      const summary = await measureArcaPerformance("prepare_summary_validation", async () => {
        const candidateSummary = await this.summaryForPreparedInvoice(job, evidence);
        validatePreparedSummary(candidateSummary, job);
        return candidateSummary;
      });
      await this.ledger.attachPreparedIssuer(job.operationId, preparedInvoiceId, jobHash, {
        cuit: summary.issuerCuit,
        name: summary.issuer,
      });
      const state = await measureArcaPerformance("prepare_state_fingerprint", async () => this.preparedInvoices.create({
          preparedInvoiceId,
          capabilityId,
          operationId: job.operationId,
          issuerKey: this.options.issuerKey,
          job,
          summary,
          pageFingerprint: await this.currentPageFingerprint(),
        }));
      const screenshotPath = await measureArcaPerformance("prepare_screenshot", async () => await this.screenshot());
      return {
        message: "Factura preparada hasta el resumen final. No se emitió el comprobante.",
        capabilityId: state.capabilityId,
        preparedInvoiceId: state.preparedInvoiceId,
        expiresAt: state.expiresAt,
        summary,
        screenshotPath,
      };
    } catch (error) {
      if (this.preparedInvoices.current?.preparedInvoiceId === preparedInvoiceId) {
        this.preparedInvoices.invalidate();
      }
      const detail = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      await this.ledger.markFailedBeforeEmit(job.operationId, preparedInvoiceId, jobHash, detail).catch(() => undefined);
      throw error;
    }
  }
  private async emitPreparedInvoice(
    preparedInvoiceId: string,
    visibleRevalidation: boolean,
    onPdfObtained?: () => number | undefined,
  ): Promise<{ message: string; operationId: string; summary: PreparedInvoiceSummary; pdfPath: string; metadataPath: string; pdfSha256: string; voucherNumber: string; cae: string; screenshotPath: string; timings?: { confirmationToPdfMs: number } }> {
    const candidate = this.preparedInvoices.current;
    assertOfficialArcaRcelUrl(this.page.url(), "la lectura del resumen preparado");
    const body = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (!/RESUMEN DE DATOS/i.test(body)) {
      if (candidate) await this.markPreparationUnknown(candidate, "La página dejó de mostrar el resumen antes de la emisión controlada.");
      throw new Error("La pantalla actual no es el resumen final de ARCA. La operación quedó bloqueada como unknown hasta consultar ARCA.");
    }
    let state: PreparedInvoiceState;
    let currentFingerprint: string;
    try {
      currentFingerprint = await this.currentPageFingerprint();
      state = this.preparedInvoices.require(preparedInvoiceId, this.options.issuerKey, currentFingerprint);
    } catch (error) {
      if (candidate?.preparedInvoiceId === preparedInvoiceId) {
        const detail = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
        if (!currentFingerprint! || candidate.pageFingerprint !== currentFingerprint) await this.markPreparationUnknown(candidate, detail);
        else await this.ledger.markFailedBeforeEmit(candidate.operationId, preparedInvoiceId, candidate.jobHash, detail).catch(() => undefined);
      }
      throw error;
    }
    let irreversibleStarted = false;
    let firstClickAttempted = false;
    let revalidationClaimed = false;
    let result: Awaited<ReturnType<typeof executeControlledEmission>> | undefined;
    let pdfReservation: PdfDestinationReservation | undefined;
    let revalidationManifest: Awaited<ReturnType<typeof requireInvoiceJobVisibleRevalidation>> | undefined;
    try {
      if (visibleRevalidation) {
        if (!this.options.revalidationCapability || state.capabilityId !== this.options.revalidationCapability) {
          throw new Error("La preparación no pertenece a la capacidad habilitada para esta revalidación visible.");
        }
        revalidationManifest = await requireInvoiceJobVisibleRevalidation(state.job, this.options.revalidationCapability);
      } else {
        await requireInvoiceJobCapability(state.job, "emit-prepared-invoice", {
          capabilityId: state.capabilityId,
          requireHidden: this.options.visibilityMode === "production-hidden",
        });
      }
      validatePreparedSummary(state.summary, state.job);
      const runtime = getRuntimePaths();
      const stagingPdfTarget = buildInvoiceStagingPdfPath(state.operationId, runtime.downloads);
      pdfReservation = await reservePrivatePdfDestination(stagingPdfTarget, runtime.downloads, runtime.root);
      result = await executeControlledEmission(this.page, {
        onIrreversible: async () => {
          // El ledger se reserva antes de cualquier otro paso de la secuencia
          // irreversible. Desde este punto, aun una caída abrupta se recupera
          // como incertidumbre y jamás como una preparación reintentable.
          await this.ledger.claimEmission(state.operationId, preparedInvoiceId, state.jobHash);
          irreversibleStarted = true;
          if (revalidationManifest) {
            try {
              await claimVisibleRevalidation(revalidationManifest, state.operationId, preparedInvoiceId);
              revalidationClaimed = true;
            } finally {
              // Incluso una reserva incierta clausura esta sesión. Una nueva
              // corrida solo podrá continuar si no quedó una atestación durable.
              this.revalidationConsumed = true;
            }
          }
        },
        onFirstClick: () => { firstClickAttempted = true; },
      });
      const screenshotPath = await this.screenshot();
      const stagingPdfPath = await this.savePrintPdf(pdfReservation.path, runtime.downloads, runtime.root, pdfReservation);
      const pdfEvidence = await inspectArcaInvoicePdf(stagingPdfPath, {
        voucherType: state.job.voucherType,
        pointOfSale: state.job.pointOfSale,
        issueDate: formatDateForArca(state.job.date),
        recipientCuit: state.job.recipientCuit,
        description: state.job.description,
        amountCents: state.job.amountCents,
      });
      const confirmationToPdfMs = onPdfObtained?.();
      const pdfSha256 = await sha256File(stagingPdfPath);
      assertEmissionResultMatchesPdf(result, pdfEvidence);
      const voucherNumber = pdfEvidence.voucherNumber;
      const cae = pdfEvidence.cae;
      const published = await publishInvoiceArtifactsForJob(stagingPdfPath, state.job, {
        cuit: state.summary.issuerCuit,
        name: state.summary.issuer,
      }, { voucherNumber, cae, pdfSha256 }, state.jobHash, runtime.downloads, runtime.root);
      await this.ledger.markEmitted(state.operationId, preparedInvoiceId, state.jobHash, {
        voucherNumber,
        cae,
        pdfPath: published.pdfPath,
        metadataPath: published.metadataPath,
        pdfSha256: published.pdfSha256,
      });
      this.preparedInvoices.invalidate();
      return { message: "Factura emitida; PDF y metadatos archivados.", operationId: state.operationId, summary: state.summary, pdfPath: published.pdfPath, metadataPath: published.metadataPath, pdfSha256: published.pdfSha256, voucherNumber, cae, screenshotPath, ...(confirmationToPdfMs === undefined ? {} : { timings: { confirmationToPdfMs } }) };
    } catch (error) {
      const detail = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      let canReturnToPreClick = irreversibleStarted && !firstClickAttempted;
      if (canReturnToPreClick && revalidationManifest && revalidationClaimed) {
        try {
          await releaseVisibleRevalidationBeforeFirstClick(revalidationManifest, state.operationId, preparedInvoiceId);
        } catch {
          canReturnToPreClick = false;
        }
      }
      const transition = irreversibleStarted
        ? canReturnToPreClick
          ? this.ledger.markFailedBeforeFirstClick(state.operationId, preparedInvoiceId, state.jobHash, detail)
          : this.ledger.markUnknown(state.operationId, preparedInvoiceId, state.jobHash, detail, result ? { voucherNumber: result.voucherNumber, cae: result.cae } : undefined)
        : this.ledger.markFailedBeforeEmit(state.operationId, preparedInvoiceId, state.jobHash, detail);
      await transition.catch(() => undefined);
      this.preparedInvoices.invalidate();
      throw error;
    } finally {
      await pdfReservation?.release();
    }
  }

  private async invalidateActivePreparation(detail: string, recognizedPreClickInterruption = false): Promise<void> {
    const safeDetail = sanitizeErrorMessage(detail);
    await invalidatePreparationBeforeMutation(
      this.preparedInvoices,
      this.ledger,
      async () => await this.currentPageFingerprint(),
      safeDetail,
      { recognizedPreClickInterruption },
    );
  }

  private async markPreparationUnknown(state: PreparedInvoiceState, detail: string): Promise<void> {
    await this.ledger.markPreparedUnknown(state.operationId, state.preparedInvoiceId, state.jobHash, sanitizeErrorMessage(detail)).catch(() => undefined);
    this.preparedInvoices.invalidate();
  }

  private async ensureRcelMenu(): Promise<void> {
    let state = await this.getState();
    if (state.readyState === "portal" || state.readyState === "service" || state.readyState === "otro") {
      this.page = await openComprobantesEnLinea(this.page, {
        strictSelectors: true,
        interactive: false,
        manualIntervention: false,
      });
      state = await this.getState();
    }

    if (state.readyState === "selector_emisor") {
      await measureArcaPerformance("prepare_issuer_selection", async () => {
        await selectRepresentedIssuer(this.page, this.options.credentials.cuit, this.options.credentials.displayName, {
          strictSelectors: true,
          interactive: false,
          manualIntervention: false,
        });
      });
      state = await this.getState();
    }

    assertOfficialArcaRcelUrl(this.page.url(), "la lectura del estado RCEL");
    const body = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (/RESUMEN DE DATOS|DATOS DE EMISI[OÓ]N|DATOS DEL RECEPTOR|DATOS DE LA OPERACI[OÓ]N/i.test(body)) {
      const menuButton = this.page.getByText(/Men[uú] Principal/i).first();
      if (await menuButton.isVisible().catch(() => false)) {
        assertOfficialArcaRcelUrl(this.page.url(), "el regreso al menú principal de RCEL");
        await menuButton.click();
        await waitForPageSettled(this.page);
        assertOfficialArcaRcelUrl(this.page.url(), "la pantalla posterior al regreso al menú RCEL");
      }
    }

    assertOfficialArcaRcelUrl(this.page.url(), "la validación del menú principal RCEL");
    const menuBody = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (!/Generar Comprobantes/i.test(menuBody)) {
      throw new Error("No se pudo dejar RCEL en el menu principal para preparar la factura.");
    }
  }

  private async summaryForPreparedInvoice(job: ResolvedInvoiceJob, evidence: InvoiceControlEvidence): Promise<PreparedInvoiceSummary> {
    const stableUrl = this.page.url();
    assertOfficialArcaRcelUrl(stableUrl, "la lectura del resumen fiscal");
    const bodyText = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    assertStableInspectablePage(this.page, stableUrl, "la lectura del resumen fiscal");
    return buildPreparedInvoiceSummary(bodyText, job, evidence, {
      sessionIssuerKey: this.options.issuerKey,
      credentialCuit: this.options.credentials.cuit,
    });
  }

  private async currentPageFingerprint(): Promise<string> {
    const stableUrl = this.page.url();
    assertOfficialArcaRcelUrl(stableUrl, "la huella de la página fiscal");
    const title = await this.page.title().catch(() => "");
    const body = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    assertStableInspectablePage(this.page, stableUrl, "la huella de la página fiscal");
    return fingerprintPage(stableUrl, title, body);
  }

  private async snapshot(): Promise<{ url: string; title: string; bodyText: string }> {
    const stableUrl = this.page.url();
    assertOfficialArcaInspectableUrl(stableUrl, "la captura de texto de la pestaña activa");
    const title = await this.page.title().catch(() => "");
    const bodyText = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    assertStableInspectablePage(this.page, stableUrl, "la captura de texto de la pestaña activa");

    return {
      url: sanitizeArcaUrlForOutput(stableUrl),
      title,
      bodyText: bodyText.slice(0, 5000),
    };
  }

  private async pages(): Promise<Array<{ index: number; current: boolean; url: string; title: string }>> {
    const pages = this.context.pages();
    const result: Array<{ index: number; current: boolean; url: string; title: string }> = [];

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index] as Page;
      const stableUrl = page.url();
      const inspectable = isOfficialArcaInspectableUrl(stableUrl);
      const title = inspectable ? await page.title().catch(() => "") : "";
      const stable = inspectable && isStableInspectablePageUrl(stableUrl, page.url());
      result.push({
        index,
        current: page === this.page,
        url: stable ? sanitizeArcaUrlForOutput(stableUrl) : "[página-no-ARCA]",
        title: stable ? title : "",
      });
    }

    return result;
  }

  private async inputs(): Promise<Array<{ index: number; type: string; name: string | null; id: string | null; valueLength: number }>> {
    const stableUrl = this.page.url();
    assertOfficialArcaInspectableUrl(stableUrl, "la inspección de campos de la pestaña activa");
    const result: Array<{ index: number; type: string; name: string | null; id: string | null; valueLength: number }> = [];
    const inputs = this.page.locator("input, textarea");
    const total = await inputs.count().catch(() => 0);

    for (let rawIndex = 0; rawIndex < Math.min(total, 100); rawIndex += 1) {
      const input = inputs.nth(rawIndex);
      if (!await input.isVisible().catch(() => false)) {
        continue;
      }

      const type = await input.getAttribute("type").catch(() => null);
      if (/^(hidden|password|button|submit|reset|checkbox|radio)$/i.test(type ?? "")) {
        continue;
      }

      result.push({
        index: result.length,
        type: type ?? "text",
        name: await input.getAttribute("name").catch(() => null),
        id: await input.getAttribute("id").catch(() => null),
        valueLength: (await input.inputValue().catch(() => "")).length,
      });
    }

    assertStableInspectablePage(this.page, stableUrl, "la inspección de campos de la pestaña activa");
    return result;
  }

  private async usePage(index: number): Promise<void> {
    const page = this.context.pages()[index];
    if (!page || page.isClosed()) {
      throw new Error(`No existe una pestana abierta con indice ${index}.`);
    }

    const stableUrl = page.url();
    assertOfficialArcaInspectableUrl(stableUrl, "la selección de una pestaña");
    await page.bringToFront().catch(() => undefined);
    await waitForPageSettled(page);
    assertStableInspectablePage(page, stableUrl, "la selección de una pestaña");
    this.page = page;
  }

  private async screenshot(): Promise<string> {
    const stableUrl = this.page.url();
    assertOfficialArcaInspectableUrl(stableUrl, "la captura visual de la pestaña activa");
    const screenshotPath = path.join(this.artifactDir, `${timestampForPath()}-screenshot.png`);
    try {
      await this.page.screenshot({ path: screenshotPath, fullPage: false, mask: [this.page.locator("iframe")] });
      assertStableInspectablePage(this.page, stableUrl, "la captura visual de la pestaña activa");
      return screenshotPath;
    } catch (error) {
      await fs.rm(screenshotPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async savePrintPdf(outputPath: string, allowedRoot: string, trustedRoot: string, existingReservation?: PdfDestinationReservation): Promise<string> {
    assertOfficialArcaGeneratedInvoicePageUrl(this.page.url());
    await singleVisible(this.page.getByText(/comprobante generado/i), "estado Comprobante Generado");
    const reservation = existingReservation ?? await reservePrivatePdfDestination(outputPath, allowedRoot, trustedRoot);
    try {
      return await downloadGeneratedInvoicePdf(this.page, reservation);
    } finally {
      await reservation.release();
    }
  }

  private async selectOptions(): Promise<Array<{ index: number; id: string | null; name: string | null; options: string[] }>> {
    const stableUrl = this.page.url();
    assertOfficialArcaInspectableUrl(stableUrl, "la inspección de opciones de la pestaña activa");
    const selects = this.page.locator("select");
    const total = await selects.count().catch(() => 0);
    const result: Array<{ index: number; id: string | null; name: string | null; options: string[] }> = [];

    for (let index = 0; index < Math.min(total, 20); index += 1) {
      const select = selects.nth(index);
      if (!await select.isVisible().catch(() => false)) {
        continue;
      }

      const optionCount = await select.locator("option").count().catch(() => 0);
      const options: string[] = [];
      for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
        const option = select.locator("option").nth(optionIndex);
        const text = (await option.textContent().catch(() => ""))?.trim() ?? "";
        const value = await option.getAttribute("value").catch(() => null);
        const label = text || value || "";
        if (label) {
          options.push(label);
        }
      }

      result.push({ index, id: await select.getAttribute("id"), name: await select.getAttribute("name"), options });
    }

    assertStableInspectablePage(this.page, stableUrl, "la inspección de opciones de la pestaña activa");
    return result;
  }

  private async appendCommandLog(command: SessionCommand, result: ArcaLiveSessionResult, startedAt: string, durationMs: number): Promise<void> {
    const line = JSON.stringify({
      startedAt,
      durationMs,
      command: redactCommandForLog(command),
      result: {
        ok: result.ok,
        status: result.status,
        state: redactSessionStateForLog(result.state),
      },
    });
    await fs.appendFile(path.join(this.artifactDir, "commands.jsonl"), `${line}\n`);
  }

  private async writeSessionEvent(event: string, data: { state: ArcaLiveSessionState }): Promise<void> {
    await fs.appendFile(path.join(this.artifactDir, "events.jsonl"), `${JSON.stringify({ event, createdAt: new Date().toISOString(), data: { state: redactSessionStateForLog(data.state) } })}\n`);
  }
}

export function redactSessionStateForLog(state: ArcaLiveSessionState): Pick<ArcaLiveSessionState,
  "readyState" | "captchaVisible" | "pageCount" | "visibilityMode" | "learnedCapability" | "revalidationCapability" | "revalidationConsumed"
> {
  return {
    readyState: state.readyState,
    captchaVisible: state.captchaVisible,
    pageCount: state.pageCount,
    visibilityMode: state.visibilityMode,
    learnedCapability: state.learnedCapability,
    revalidationCapability: state.revalidationCapability,
    revalidationConsumed: state.revalidationConsumed,
  };
}

async function singleVisible(locator: Locator, description: string): Promise<Locator> {
  const total = await locator.count().catch(() => 0);
  const visible: Locator[] = [];

  for (let index = 0; index < Math.min(total, 25); index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) {
      visible.push(current);
    }
  }

  if (visible.length === 0) {
    throw new Error(`No se encontro ${description}.`);
  }

  if (visible.length > 1) {
    throw new Error(`Selector ambiguo para ${description}: ${visible.length} elementos visibles.`);
  }

  return visible[0] as Locator;
}

export function classifyReadyState(url: string, title: string, body: string): ArcaLiveSessionState["readyState"] {
  if (/\/expiredSession(?:[/?#]|$)/i.test(url) || /TU SESI[ÓO]N HA EXPIRADO/i.test(body)) {
    return "expired";
  }

  if (/^403\s+Forbidden$/i.test(title.trim()) || (/^Forbidden\b/i.test(body.trim()) && /permission to access/i.test(body))) {
    return "forbidden";
  }

  if (isOfficialArcaAuthUrl(url)) {
    return "auth";
  }

  if (isOfficialArcaRcelUrl(url)) {
    if (/Seleccione la Empresa a representar/i.test(body)) return "selector_emisor";
    return "rcel_menu";
  }

  if (isOfficialArcaPortalUrl(url)) {
    return "portal";
  }

  if (isOfficialArcaPortalOriginUrl(url) || isOfficialArcaRcelOriginUrl(url)) {
    return "service";
  }

  return "otro";
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertFastInvoiceJob(job: ResolvedInvoiceJob): void {
  const missing: string[] = [];
  if (!job.pointOfSale) missing.push("pointOfSale");
  if (!job.voucherType) missing.push("voucherType");
  if (!job.recipientVatCondition) missing.push("recipientVatCondition");
  if (!job.saleCondition) missing.push("saleCondition");
  if (job.currency !== "ARS") missing.push("currency=ARS");
  if (job.concept.toLowerCase().includes("servicios")) {
    if (!job.billingPeriodFrom) missing.push("billingPeriodFrom");
    if (!job.billingPeriodTo) missing.push("billingPeriodTo");
    if (!job.dueDate) missing.push("dueDate");
  }

  if (missing.length > 0) {
    throw new Error(`La ruta rapida requiere datos completos en el job. Faltan: ${missing.join(", ")}.`);
  }
}

export function buildPreparedInvoiceSummary(
  bodyText: string,
  job: ResolvedInvoiceJob,
  evidence: InvoiceControlEvidence,
  identity: { sessionIssuerKey: string; credentialCuit: string },
): PreparedInvoiceSummary {
  if (!evidence.issuer || !evidence.issuerCuit) {
    throw new Error("No existe evidencia del control visible del emisor representado.");
  }

  const issuerSummaryBlock = extractIssuerSummaryEvidence(bodyText);
  const issuerSummary = assertIssuerEvidenceMatches(
    issuerSummaryBlock,
    { issuer: evidence.issuer, issuerCuit: evidence.issuerCuit },
    [identity.sessionIssuerKey, job.issuerKey, identity.credentialCuit],
  );
  const currency = requireVerifiedCurrency(job, evidence);
  if (!evidence.quantity || !evidence.unitPrice || !evidence.subtotal || !evidence.total) {
    throw new Error("No existe evidencia visible completa de cantidad, precio unitario, subtotal y total.");
  }
  if (!/^1(?:[.,]0+)?$/u.test(evidence.quantity.trim())
    || !moneyEvidenceMatches(evidence.unitPrice, job.amountCents)
    || !moneyEvidenceMatches(evidence.subtotal, job.amountCents)
    || !moneyEvidenceMatches(evidence.total, job.amountCents)) {
    throw new Error("La evidencia visible de cantidad, precio unitario, subtotal o total no coincide con el job.");
  }
  const missingExpectedSignals = missingExpectedSummarySignals(bodyText, job, evidence);

  return {
    issueDate: evidence.issueDate ?? "",
    issueDateSource: "control_arca",
    issuer: issuerSummary.issuer,
    issuerCuit: issuerSummary.issuerCuit,
    issuerCommercialAddress: issuerSummary.issuerCommercialAddress,
    voucherType: job.voucherType ?? "",
    pointOfSale: extractAfter(bodyText, /Punto de Venta\s+([0-9]+)/i) ?? job.pointOfSale ?? "",
    concept: job.concept,
    currency,
    billingPeriodFrom: evidence.billingPeriodFrom,
    billingPeriodTo: evidence.billingPeriodTo,
    dueDate: evidence.dueDate,
    recipientCuit: onlyDigits(job.recipientCuit),
    recipientName: evidence.recipientName,
    recipientVatCondition: evidence.recipientVatCondition,
    recipientCommercialAddress: evidence.recipientCommercialAddress,
    saleCondition: job.saleCondition,
    description: evidence.description ?? job.description,
    quantity: evidence.quantity ?? "",
    unitPrice: formatArcaMoney(job.amount),
    subtotal: formatArcaMoney(job.amount),
    total: formatArcaMoney(job.amount),
    amount: formatArcaMoney(job.amount),
    rawContainsExpected: missingExpectedSignals.length === 0,
    missingExpectedSignals,
  };
}

export function validatePreparedSummary(summary: PreparedInvoiceSummary, job: ResolvedInvoiceJob): void {
  const normalizedExpectedCuit = onlyDigits(job.issuerKey);
  if (!summary.issuer.trim() || !summary.issuerCommercialAddress.trim() || onlyDigits(summary.issuerCuit) !== normalizedExpectedCuit) {
    throw new Error("El resumen preparado no contiene una identidad del emisor válida y coincidente.");
  }
  if (!summary.rawContainsExpected) {
    throw new Error(`El resumen de ARCA no contiene todos los datos esperados del job. No se emite. Faltan: ${summary.missingExpectedSignals.join(" | ")}`);
  }
  if (summary.currency !== "ARS") {
    throw new Error("El resumen preparado no contiene moneda local ARS verificada.");
  }
  const requiredControlEvidence = [
    ["fecha de emisión", summary.issueDate],
    ["período desde", summary.billingPeriodFrom],
    ["período hasta", summary.billingPeriodTo],
    ["vencimiento", summary.dueDate],
    ["razón social del receptor", summary.recipientName],
    ["condición frente al IVA", summary.recipientVatCondition],
    ["domicilio comercial del receptor", summary.recipientCommercialAddress],
    ["descripción", summary.description],
    ["cantidad", summary.quantity],
    ["precio unitario", summary.unitPrice],
    ["subtotal", summary.subtotal],
    ["total", summary.total],
  ] as const;
  const missingControlEvidence = requiredControlEvidence.filter(([, value]) => !value?.trim()).map(([label]) => label);
  if (missingControlEvidence.length > 0) {
    throw new Error(`La preparación no conserva evidencia visible de: ${missingControlEvidence.join(", ")}.`);
  }
  const mismatched: string[] = [];
  if (!sameSummaryText(summary.issueDate, formatDateForArca(job.date))) mismatched.push("fecha de emisión");
  if (!sameSummaryText(summary.voucherType, job.voucherType)) mismatched.push("tipo de comprobante");
  if (canonicalPointOfSaleForSummary(summary.pointOfSale) !== canonicalPointOfSaleForSummary(job.pointOfSale)) mismatched.push("punto de venta");
  if (!sameSummaryText(summary.concept, job.concept)) mismatched.push("concepto");
  if (!sameSummaryText(summary.billingPeriodFrom, job.billingPeriodFrom ? formatDateForArca(job.billingPeriodFrom) : undefined)) mismatched.push("período desde");
  if (!sameSummaryText(summary.billingPeriodTo, job.billingPeriodTo ? formatDateForArca(job.billingPeriodTo) : undefined)) mismatched.push("período hasta");
  if (!sameSummaryText(summary.dueDate, job.dueDate ? formatDateForArca(job.dueDate) : undefined)) mismatched.push("vencimiento");
  if (onlyDigits(summary.recipientCuit) !== onlyDigits(job.recipientCuit)) mismatched.push("CUIT receptor");
  if (job.recipientName && !sameSummaryText(summary.recipientName, job.recipientName)) mismatched.push("razón social del receptor");
  if (!sameSummaryText(summary.recipientVatCondition, job.recipientVatCondition)) mismatched.push("condición frente al IVA");
  if (job.recipientCommercialAddress && !commercialAddressesMatch(summary.recipientCommercialAddress ?? "", job.recipientCommercialAddress)) mismatched.push("domicilio comercial");
  if (!saleConditionMatches(summary.saleCondition, job.saleCondition)) mismatched.push("condición de venta");
  if (!sameSummaryText(summary.description, job.description)) mismatched.push("descripción");
  if (!/^1(?:[.,]0+)?$/u.test(summary.quantity.trim())) mismatched.push("cantidad");
  if (!sameSummaryText(summary.unitPrice, formatArcaMoney(job.amount))) mismatched.push("precio unitario");
  if (!sameSummaryText(summary.subtotal, formatArcaMoney(job.amount))) mismatched.push("subtotal");
  if (!sameSummaryText(summary.total, formatArcaMoney(job.amount))) mismatched.push("importe total");
  if (!sameSummaryText(summary.amount, summary.total)) mismatched.push("alias de importe total");
  if (mismatched.length > 0) {
    throw new Error(`El resumen preparado difiere del job en: ${mismatched.join(", ")}.`);
  }
}

function requireVerifiedCurrency(job: ResolvedInvoiceJob, evidence: InvoiceControlEvidence): "ARS" {
  if (job.currency !== "ARS" || evidence.currency !== "ARS") {
    throw new Error("No existe evidencia visible de que Moneda Extranjera esté desmarcada para ARS.");
  }
  return "ARS";
}

type ExpectedSummarySignal = string | string[];

export function missingExpectedSummarySignals(
  bodyText: string,
  job: ResolvedInvoiceJob,
  evidence: Pick<InvoiceControlEvidence, "recipientName" | "recipientCommercialAddress" | "recipientVatCondition" | "description"> = {},
): string[] {
  const missing: string[] = [];
  const expectedRecipientName = evidence.recipientName ?? job.recipientName;
  const expectedVat = evidence.recipientVatCondition ?? job.recipientVatCondition;
  const expectedDescription = evidence.description ?? job.description;
  const voucherType = extractSummaryVoucherType(bodyText);
  const pointOfSale = extractAfter(bodyText, /(?:^|\n)\s*Punto de Venta\s+([0-9]{1,5})\s*(?:\r?\n|$)/im);
  const concept = extractAfter(bodyText, /(?:^|\n)\s*Conceptos? a Inclu[ií]r\s+([^\r\n]+)/im);
  const period = bodyText.match(/(?:^|\n)\s*Per[ií]odo Facturado\s+desde:\s*(\d{2}\/\d{2}\/\d{4})\s+hasta:\s*(\d{2}\/\d{2}\/\d{4})/im);
  const dueDate = extractAfter(bodyText, /(?:^|\n)\s*Vto\.?(?:\s+para el Pago)?\s+([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s*(?:\r?\n|$)/im);
  const recipientBlock = extractSummarySection(bodyText, /Datos del Receptor/i, /Detalle de la Operaci[oó]n/i);
  const recipientCuit = extractAfter(recipientBlock, /(?:^|\n)\s*CUIT\s+([0-9-]{11,13})\s*(?:\r?\n|$)/im);
  const recipientName = extractAfter(recipientBlock, /(?:^|\n)\s*Raz[oó]n Social\s+([^\r\n]+)/im);
  const recipientVat = extractAfter(recipientBlock, /(?:^|\n)\s*Condici[oó]n frente al IVA\s+([^\r\n]+)/im);
  const saleCondition = extractAfter(recipientBlock, /(?:^|\n)\s*Condiciones? de Venta\s+([^\r\n]+)/im);
  const detailBlock = extractSummarySection(bodyText, /Detalle de la Operaci[oó]n/i);
  const total = extractAfter(detailBlock, /(?:^|\n)\s*Importe Total:\s*\$?\s*([0-9.,]+)\s*(?:\r?\n|$)/im);

  if (!sameSummaryText(voucherType, job.voucherType)) missing.push(job.voucherType);
  if (canonicalPointOfSaleForSummary(pointOfSale) !== canonicalPointOfSaleForSummary(job.pointOfSale)) missing.push(`Punto de Venta: ${job.pointOfSale}`);
  if (!sameSummaryText(concept, job.concept)) missing.push(`Conceptos a Incluir: ${job.concept}`);
  if (job.billingPeriodFrom && !sameSummaryText(period?.[1], formatDateForArca(job.billingPeriodFrom))) missing.push(`Período desde: ${formatDateForArca(job.billingPeriodFrom)}`);
  if (job.billingPeriodTo && !sameSummaryText(period?.[2], formatDateForArca(job.billingPeriodTo))) missing.push(`Período hasta: ${formatDateForArca(job.billingPeriodTo)}`);
  if (job.dueDate && !sameSummaryText(dueDate, formatDateForArca(job.dueDate))) missing.push(`Vencimiento: ${formatDateForArca(job.dueDate)}`);
  if (onlyDigits(recipientCuit ?? "") !== onlyDigits(job.recipientCuit)) missing.push(`CUIT receptor: ${onlyDigits(job.recipientCuit)}`);
  if (expectedRecipientName && !sameSummaryText(recipientName, expectedRecipientName)) missing.push(`Razón social receptor: ${expectedRecipientName}`);
  if (!sameSummaryText(recipientVat, expectedVat)) missing.push(`Condición frente al IVA: ${expectedVat}`);
  if (!saleConditionMatches(saleCondition, job.saleCondition)) missing.push(`Condición de venta: ${formatExpectedSummarySignal(saleConditionSummarySignal(job.saleCondition) ?? job.saleCondition)}`);
  if (!invoiceItemRowMatches(detailBlock, expectedDescription, job.amount)) {
    missing.push(`Ítem: ${expectedDescription}; cantidad 1; precio unitario ${formatArcaMoney(job.amount)}`);
  }
  if (!sameSummaryText(total, formatArcaMoney(job.amount))) missing.push(formatArcaMoney(job.amount));

  const summaryAddress = extractAfter(recipientBlock, /(?:^|\n)\s*Domicilio Comercial\s+([^\r\n]+)/im);
  const expectedAddress = evidence.recipientCommercialAddress ?? job.recipientCommercialAddress;
  if (!summaryAddress) {
    missing.push("Domicilio Comercial");
  } else if (expectedAddress && !commercialAddressesMatch(summaryAddress, expectedAddress)) {
    missing.push(`Domicilio Comercial: ${expectedAddress}`);
  }

  return missing;
}

function extractSummaryVoucherType(bodyText: string): string | undefined {
  return bodyText.match(/(?:^|\n)[^\r\n]*GENERACI[OÓ]N DE COMPROBANTES\s*-\s*(FACTURA\s+[A-Z])\s*(?:\r?\n|$)/im)?.[1]?.trim()
    ?? bodyText.match(/(?:^|\n)\s*(Factura\s+[A-Z])\s*(?:\r?\n|$)/im)?.[1]?.trim();
}

function extractSummarySection(bodyText: string, start: RegExp, end?: RegExp): string {
  const startMatch = start.exec(bodyText);
  if (!startMatch || startMatch.index === undefined) return "";
  const fromStart = bodyText.slice(startMatch.index + startMatch[0].length);
  if (!end) return fromStart;
  const endMatch = end.exec(fromStart);
  return endMatch?.index === undefined ? fromStart : fromStart.slice(0, endMatch.index);
}

function sameSummaryText(actual: string | undefined, expected: string | undefined): boolean {
  return Boolean(actual && expected) && normalizeForMatch(actual as string) === normalizeForMatch(expected as string);
}

function saleConditionMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const alternatives = saleConditionSummarySignal(expected);
  return (Array.isArray(alternatives) ? alternatives : [alternatives]).some((value) => value && sameSummaryText(actual, value));
}

function canonicalPointOfSaleForSummary(value: string | undefined): string {
  const digits = onlyDigits(value ?? "");
  return /^\d{1,5}$/.test(digits) ? digits.padStart(5, "0") : "";
}

function invoiceItemRowMatches(detailBlock: string, expectedDescription: string, amount: number): boolean {
  const tableBlock = detailBlock.split(/(?:^|\n)\s*(?:Subtotal:|Otros Tributos:|Importe Total:)/im)[0] ?? "";
  const normalizedDescription = normalizeForMatch(expectedDescription);
  const matchingRows = tableBlock
    .split(/\r?\n/u)
    .map((row) => normalizeForMatch(row))
    .filter((row) => row.includes(normalizedDescription));
  if (matchingRows.length !== 1) return false;
  const row = matchingRows[0] as string;
  const descriptionIndex = row.indexOf(normalizedDescription);
  const afterDescription = row.slice(descriptionIndex + normalizedDescription.length).trimStart();
  if (!/^1(?: 00)?(?: |$)/.test(afterDescription)) return false;
  const normalizedAmount = normalizeForMatch(formatArcaMoney(amount));
  return countOccurrences(afterDescription, normalizedAmount) >= 2;
}

function countOccurrences(value: string, expected: string): number {
  if (!expected) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(expected, offset)) >= 0) {
    count += 1;
    offset += expected.length;
  }
  return count;
}

function saleConditionSummarySignal(value: string | undefined): ExpectedSummarySignal | undefined {
  if (!value) {
    return undefined;
  }

  if (/^otr[oa]$/i.test(value.trim())) {
    return ["Otro", "Otra"];
  }

  return value;
}

function formatExpectedSummarySignal(signal: ExpectedSummarySignal): string {
  return Array.isArray(signal) ? signal.join(" / ") : signal;
}

function extractAfter(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1]?.trim();
}

export function assertEmissionResultMatchesPdf(
  result: Awaited<ReturnType<typeof executeControlledEmission>>,
  pdf: ArcaInvoicePdfEvidence,
): void {
  if (result.voucherNumber && result.voucherNumber !== pdf.voucherNumber) {
    throw new Error("El número mostrado por ARCA no coincide con el comprobante extraído del PDF.");
  }
  if (result.cae && result.cae !== pdf.cae) {
    throw new Error("El CAE mostrado por ARCA no coincide con el comprobante extraído del PDF.");
  }
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function formatArcaMoney(amount: number): string {
  return amount.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function moneyEvidenceMatches(value: string, expectedCents: number): boolean {
  const compact = value.replace(/\s|\$/gu, "").replace(/[^0-9,.-]/gu, "");
  if (!/\d/u.test(compact) || compact.startsWith("-")) return false;
  const separator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  const hasDecimals = separator >= 0 && compact.length - separator - 1 === 2;
  const whole = (hasDecimals ? compact.slice(0, separator) : compact).replace(/\D/gu, "") || "0";
  const fraction = hasDecimals ? compact.slice(separator + 1).replace(/\D/gu, "") : "00";
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) && cents === expectedCents;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isStableInspectablePageUrl(expectedUrl: string, currentUrl: string): boolean {
  return expectedUrl === currentUrl && isOfficialArcaInspectableUrl(currentUrl);
}

function assertStableInspectablePage(page: Page, expectedUrl: string, action: string): void {
  if (page.isClosed() || !isStableInspectablePageUrl(expectedUrl, page.url())) {
    throw new Error(`ARCA_UNTRUSTED_INSPECTION_PAGE: la pestaña cambió de URL u origen durante ${action}; el resultado fue descartado.`);
  }
}

export function invalidatesPreparation(type: SessionCommand["type"]): boolean {
  return !["status", "snapshot", "screenshot", "emit-prepared-invoice", "revalidate-prepared-invoice"].includes(type);
}

function isReadOnlyCommand(command: SessionCommand): boolean {
  return ["status", "snapshot", "screenshot", "pages", "select-options", "inputs"].includes(command.type);
}

function isIrreversibleCommand(command: SessionCommand): boolean {
  return command.type === "emit-prepared-invoice" || command.type === "revalidate-prepared-invoice";
}

function isRecognizedPreClickInterruption(state: ArcaLiveSessionState["readyState"] | undefined): boolean {
  return state !== undefined && ["auth", "captcha", "expired", "forbidden"].includes(state);
}
