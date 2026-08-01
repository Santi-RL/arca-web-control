import { Locator, Page } from "playwright";
import { ResolvedInvoiceJob } from "../types.js";
import { formatDateForArca } from "../utils/date.js";
import { askText } from "../io/prompt.js";
import { pauseIfCaptcha } from "./captcha.js";
import { FlowContext } from "./flowContext.js";
import { assertNoArcaAccessFailure, candidate, clickFirstVisible, fillFirstVisible, selectOptionContaining, waitForArcaDocumentReady, waitForUniqueSelectedEnabledOptionByVisibleText } from "./pageHelpers.js";
import { captureCurrencyEvidence, captureDateEvidence, captureDetailEvidence, captureIssuerEvidence, captureRecipientEvidence, InvoiceControlEvidence } from "./controlEvidence.js";
import { assertInvoiceRegimeConfigured } from "../issuers/profile.js";
import { measureArcaPerformance } from "./performance.js";
import { assertOfficialArcaRcelUrl } from "./officialUrls.js";
import {
  commercialAddressesMatch,
  isCommercialAddressPlaceholder,
  isOtherCommercialAddressOption,
  readRecipientCommercialAddress,
  recipientCommercialAddressSelect,
  waitForUniqueVisibleAddressInput,
} from "./recipientCommercialAddress.js";

export const initialVoucherTypeSelector = "#universocomprobante, select[name='universoComprobante' i], #idtipocomprobante, select[name='idTipoComprobante' i]";

export async function fillInvoice(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la preparación de la factura");
  await assertInvoiceRegimeConfigured(job);
  const evidence: InvoiceControlEvidence = {};
  Object.assign(evidence, await captureIssuerEvidence(page, job));
  console.log("Entrando a generacion de comprobante...");
  await context?.guided?.checkpoint(page, {
    title: "Antes de generar comprobante",
    expected: "Debe verse la opcion exacta 'Generar Comprobantes' en el menu principal de RCEL.",
    nextAction: "El sistema hara click en 'Generar Comprobantes'.",
  });

  await measureArcaPerformance("prepare_open_generation", async () => {
    assertOfficialArcaRcelUrl(page.url(), "la apertura de Generar Comprobantes");
    await clickFirstVisible([
      candidate(page.getByRole("link", { name: /^generar comprobantes$/i }), "link exacto Generar Comprobantes"),
      candidate(page.getByRole("button", { name: /^generar comprobantes$/i }), "boton exacto Generar Comprobantes"),
      candidate(page.locator("a, button, input[type='button'], input[type='submit'], [onclick]").filter({ hasText: /^Generar Comprobantes$/i }), "control exacto Generar Comprobantes"),
      candidate(page.getByText(/^Generar Comprobantes$/i), "texto exacto Generar Comprobantes"),
    ], "generacion de comprobante", context);
    await measureArcaPerformance("prepare_screen_point_of_sale", async () => {
      await waitForInvoiceScreen(page, page.locator("#puntodeventa, select[name='puntodeventa' i]"), "punto de venta", context);
    });

    if (await page.getByText(/^Generar Comprobantes$/i).first().isVisible().catch(() => false)) {
      throw new Error("No se avanzo desde el menu principal de RCEL despues de hacer click en Generar Comprobantes.");
    }
  });

  console.log("Completando datos iniciales...");
  const pointOfSale = job.pointOfSale ?? await requiredInteractiveText(context, "ARCA solicita punto de venta. Ingresalo tal como aparece en la pantalla");
  const voucherType = job.voucherType ?? await requiredInteractiveText(context, "ARCA solicita tipo de comprobante. Ingresalo tal como aparece en la pantalla");

  await context?.guided?.checkpoint(page, {
    title: "Pantalla de punto de venta y tipo",
    expected: `Debe verse la pantalla con los selects de punto de venta y tipo. Se usara punto de venta ${pointOfSale} y tipo ${voucherType}.`,
    nextAction: "El sistema seleccionara esos valores en los dos selects visibles.",
  });

  await measureArcaPerformance("prepare_initial_data", async () => {
    await selectInitialVoucherData(page, pointOfSale, voucherType, context);

  await context?.guided?.checkpoint(page, {
    title: "Datos iniciales cargados",
    expected: `Debe verse punto de venta ${pointOfSale} y tipo ${voucherType}.`,
    nextAction: "El sistema continuara al paso de fecha y concepto.",
  });

    assertOfficialArcaRcelUrl(page.url(), "el envío de punto de venta y tipo de comprobante");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /continuar|siguiente/i }), "boton continuar/siguiente"),
      candidate(page.getByRole("link", { name: /continuar|siguiente/i }), "link continuar/siguiente"),
      candidate(page.locator("input[type='submit']"), "input submit"),
    ], "continuar datos iniciales", context);
    await measureArcaPerformance("prepare_screen_emission", async () => {
      await waitForInvoiceScreen(page, page.locator("#idconcepto, select[name='idConcepto' i]"), "datos de emisión", context);
    });
  });

  console.log("Completando fecha y concepto...");
  await measureArcaPerformance("prepare_emission_data", async () => {
    await fillEmissionDateAndConcept(page, job, context);
    Object.assign(evidence, await captureCurrencyEvidence(page, job));
    await fillBillingPeriodAndDueDate(page, job, context);
    Object.assign(evidence, await captureDateEvidence(page, job));
    await selectActivityIfNeeded(page, job, context);

  await context?.guided?.checkpoint(page, {
    title: "Fecha, concepto, periodo y vencimiento cargados",
    expected: `Debe verse fecha ${formatDateForArca(job.date)}, concepto ${job.concept}, moneda local ARS con Moneda Extranjera desmarcada${job.billingPeriodFrom ? `, periodo desde ${formatDateForArca(job.billingPeriodFrom)}` : ""}${job.billingPeriodTo ? ` hasta ${formatDateForArca(job.billingPeriodTo)}` : ""}${job.dueDate ? ` y vencimiento ${formatDateForArca(job.dueDate)}` : ""}. Actividad asociada y referencia comercial deben quedar sin completar salvo indicacion expresa.`,
    nextAction: "El sistema continuara al paso del receptor.",
  });

    assertOfficialArcaRcelUrl(page.url(), "el envío de fecha, concepto y período");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /continuar|siguiente/i }), "boton continuar/siguiente"),
      candidate(page.getByRole("link", { name: /continuar|siguiente/i }), "link continuar/siguiente"),
      candidate(page.locator("input[type='submit']"), "input submit"),
    ], "continuar fecha y concepto", context);
    await measureArcaPerformance("prepare_screen_recipient", async () => {
      await waitForInvoiceScreen(page, page.locator("#idtipodocreceptor, select[name*='tipodoc' i], select[id*='tipodoc' i]"), "datos del receptor", context);
    });
  });

  console.log("Completando receptor...");
  await measureArcaPerformance("prepare_recipient_data", async () => {
    await fillRecipientData(page, job, context);
    Object.assign(evidence, await captureRecipientEvidence(page, job));

  const recipientExpected = job.recipientKind === "anonymous-final-consumer"
    ? `Debe verse condición IVA Consumidor Final, sin número de documento, razón social ni domicilio${job.saleCondition ? ` y condición de venta ${job.saleCondition}` : ""}.`
    : `Debe verse el CUIT receptor ${onlyDigits(job.recipientCuit)}${job.recipientName ? ` (${job.recipientName})` : ""}${job.recipientVatCondition ? `, condición IVA ${job.recipientVatCondition}` : ""}${job.saleCondition ? ` y condición de venta ${job.saleCondition}` : ""}. Razón social y domicilio deben estar autocompletados por ARCA.`;

  await context?.guided?.checkpoint(page, {
    title: "Receptor cargado",
    expected: recipientExpected,
    nextAction: "El sistema continuara al detalle de la factura.",
  });

    assertOfficialArcaRcelUrl(page.url(), "el envío de los datos del receptor");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /continuar|siguiente/i }), "boton continuar/siguiente"),
      candidate(page.getByRole("link", { name: /continuar|siguiente/i }), "link continuar/siguiente"),
      candidate(page.locator("input[type='submit']"), "input submit"),
    ], "continuar receptor", context);
    await measureArcaPerformance("prepare_screen_operation", async () => {
      await waitForInvoiceScreen(page, page.locator("#detalle_descripcion1, [name='detalle_descripcion1']"), "datos de la operación", context);
    });
  });

  console.log("Completando detalle e importe...");
  await measureArcaPerformance("prepare_operation_detail", async () => {
    const amount = formatArcaUnitPrice(job.amount);
    Object.assign(evidence, await fillOperationDetail(page, job.description, amount, job.amountCents, job.unit, context));
    Object.assign(evidence, await captureDetailEvidence(page, job));

  await context?.guided?.checkpoint(page, {
    title: "Detalle e importe cargados",
    expected: `Debe verse descripcion "${job.description}", cantidad 1 y precio unitario ${amount}. Subtotal/total deben calcularse automaticamente.`,
    nextAction: "El sistema continuara al resumen previo a la emision.",
  });

    assertOfficialArcaRcelUrl(page.url(), "el envío del detalle de la operación");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /continuar|siguiente|confirmar datos/i }), "boton continuar/siguiente/confirmar datos"),
      candidate(page.getByRole("link", { name: /continuar|siguiente|confirmar datos/i }), "link continuar/siguiente/confirmar datos"),
      candidate(page.locator("input[type='submit']"), "input submit"),
    ], "continuar detalle", context);
    await measureArcaPerformance("prepare_screen_summary", async () => {
      await waitForInvoiceScreen(page, page.getByText(/RESUMEN DE DATOS/i), "resumen final", context);
    });
  });
  return evidence;
}

async function fillEmissionDateAndConcept(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la carga de fecha y concepto");
  await fillFirstVisible([
    candidate(page.getByRole("textbox", { name: /Fecha del Comprobante/i }), "textbox Fecha del Comprobante"),
    candidate(page.locator("input[name*='fecha' i]"), "input name contiene fecha"),
    candidate(page.locator("input[id*='fecha' i]"), "input id contiene fecha"),
  ], formatDateForArca(job.date), "fecha", context);
  const concept = await uniqueVisibleControl(page.locator("#idconcepto, select[name='idConcepto' i]"), "concepto");
  await selectOptionContaining(concept, job.concept);
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "concepto", candidate: "#idconcepto o name=idConcepto", result: "used", visibleCount: 1 });
}

async function fillBillingPeriodAndDueDate(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la carga del período y vencimiento");
  if (job.billingPeriodFrom) {
    await fillFirstVisible([
      candidate(page.getByLabel(/periodo.*desde|desde/i), "campo por label periodo desde"),
      candidate(page.locator("input[name*='periodo' i][name*='desde' i]"), "input name contiene periodo desde"),
      candidate(page.locator("input[id*='periodo' i][id*='desde' i]"), "input id contiene periodo desde"),
      candidate(page.locator("input[name*='desde' i]"), "input name contiene desde"),
    ], formatDateForArca(job.billingPeriodFrom), "periodo facturado desde", context);
  }

  if (job.billingPeriodTo) {
    await fillFirstVisible([
      candidate(page.getByLabel(/periodo.*hasta|hasta/i), "campo por label periodo hasta"),
      candidate(page.locator("input[name*='periodo' i][name*='hasta' i]"), "input name contiene periodo hasta"),
      candidate(page.locator("input[id*='periodo' i][id*='hasta' i]"), "input id contiene periodo hasta"),
      candidate(page.locator("input[name*='hasta' i]"), "input name contiene hasta"),
    ], formatDateForArca(job.billingPeriodTo), "periodo facturado hasta", context);
  }

  if (job.dueDate) {
    await fillFirstVisible([
      candidate(page.getByLabel(/vencimiento|vto/i), "campo por label vencimiento"),
      candidate(page.locator("input[name*='venc' i]"), "input name contiene venc"),
      candidate(page.locator("input[id*='venc' i]"), "input id contiene venc"),
    ], formatDateForArca(job.dueDate), "fecha de vencimiento", context);
  }
}

async function fillRecipientData(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la carga del receptor");
  if (job.recipientKind === "anonymous-final-consumer") {
    const documentTypeLocator = page.locator("#idtipodocreceptor, select[name*='tipodoc' i], select[id*='tipodoc' i]");
    const documentType = await uniqueVisibleControl(documentTypeLocator, "tipo de documento receptor");
    const dependencyObservation = await observeRecipientDocumentTypeDependency(page, documentType);
    try {
      const vat = await uniqueVisibleControl(page.locator("#idivareceptor, select[name*='ivareceptor' i]"), "condición IVA receptor");
      await selectOptionContaining(vat, job.recipientVatCondition);
      await context?.guided?.recordSelectorAttempt({ action: "select", description: "condición IVA receptor", candidate: "#idivareceptor o name contiene ivareceptor", result: "used", visibleCount: 1 });
      await waitForStableAnonymousDocumentType(page, documentTypeLocator, dependencyObservation);
    } finally {
      await stopObservingRecipientDocumentTypeDependency(page, dependencyObservation);
    }
    await checkSaleCondition(page, job.saleCondition, context);
    return;
  }
  if (job.recipientVatCondition) {
    const vat = await uniqueVisibleControl(page.locator("#idivareceptor, select[name*='ivareceptor' i]"), "condición IVA receptor");
    await selectOptionContaining(vat, job.recipientVatCondition);
    await context?.guided?.recordSelectorAttempt({ action: "select", description: "condición IVA receptor", candidate: "#idivareceptor o name contiene ivareceptor", result: "used", visibleCount: 1 });
  }
  const documentType = await uniqueVisibleControl(page.locator("#idtipodocreceptor, select[name*='tipodoc' i], select[id*='tipodoc' i]"), "tipo de documento receptor");
  await selectOptionContaining(documentType, "CUIT");
  const cuit = onlyDigits(job.recipientCuit);
  await fillFirstVisible([
    candidate(page.locator("#nrodocreceptor"), "#nrodocreceptor"),
    candidate(page.locator("input[name*='nrodoc' i]"), "input name contiene nrodoc"),
    candidate(page.locator("input[name*='cuit' i]"), "input name contiene cuit"),
  ], cuit, "CUIT receptor sin guiones", context);
  await page.keyboard.press("Tab").catch(() => undefined);
  await measureArcaPerformance("prepare_recipient_autofill", async () => await waitForRecipientAutofill(page));
  await ensureCommercialAddress(page, job, context);
  await checkSaleCondition(page, job.saleCondition, context);
}

type RecipientDocumentTypeDependencyObservation = {
  initialOptionsSignature: string;
  initialSelectHandle: Awaited<ReturnType<Locator["elementHandle"]>>;
  initialMutationRevision: number;
  navigationRevision: number;
  onFrameNavigated: (frame: ReturnType<Page["mainFrame"]>) => void;
};

type RecipientDocumentTypeMutationState = {
  revision: number;
  observer: MutationObserver;
};

type RecipientDocumentTypeMutationGlobal = typeof globalThis & {
  __arcaRecipientDocumentTypeMutationState?: RecipientDocumentTypeMutationState;
};

async function observeRecipientDocumentTypeDependency(
  page: Page,
  select: Locator,
): Promise<RecipientDocumentTypeDependencyObservation> {
  const observation: RecipientDocumentTypeDependencyObservation = {
    initialOptionsSignature: await recipientDocumentTypeOptionsSignature(select),
    initialSelectHandle: await select.elementHandle(),
    initialMutationRevision: 0,
    navigationRevision: 0,
    onFrameNavigated: () => undefined,
  };
  observation.onFrameNavigated = (frame) => {
    if (frame === page.mainFrame()) observation.navigationRevision += 1;
  };
  page.on("framenavigated", observation.onFrameNavigated);
  await select.evaluate((element) => {
    const scope = globalThis as RecipientDocumentTypeMutationGlobal;
    scope.__arcaRecipientDocumentTypeMutationState?.observer.disconnect();
    const state = { revision: 0 } as RecipientDocumentTypeMutationState;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList"
        || record.type === "characterData"
        || record.type === "attributes"
        || record.target instanceof HTMLOptionElement
        || record.target instanceof HTMLOptGroupElement)) {
        state.revision += 1;
      }
    });
    state.observer = observer;
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["disabled", "label", "selected"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    scope.__arcaRecipientDocumentTypeMutationState = state;
  });
  observation.initialMutationRevision = await recipientDocumentTypeMutationRevision(page);
  return observation;
}

async function waitForStableAnonymousDocumentType(
  page: Page,
  locator: Locator,
  observation: RecipientDocumentTypeDependencyObservation,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previousStableState = "";
  let stableSince = 0;
  let stableReads = 0;

  while (Date.now() < deadline) {
    assertOfficialArcaRcelUrl(page.url(), "la espera del tipo documental dependiente de la condición IVA");
    const controls = await visibleLocators(locator).catch(() => []);
    if (controls.length > 1) {
      throw new Error("ARCA mostró controles ambiguos para el tipo de documento receptor.");
    }
    const current = controls[0];
    if (current) {
      const signature = await recipientDocumentTypeOptionsSignature(current).catch(() => "");
      const selectWasReplaced = await current
        .evaluate((element, initialElement) => element !== initialElement, observation.initialSelectHandle)
        .catch(() => true);
      const mutationRevision = await recipientDocumentTypeMutationRevision(page);
      const dependencyWasObserved = observation.navigationRevision > 0
        || mutationRevision > observation.initialMutationRevision
        || selectWasReplaced
        || signature !== observation.initialOptionsSignature;
      const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
      const stableState = `${observation.navigationRevision}\u0000${mutationRevision}\u0000${selectWasReplaced ? "1" : "0"}\u0000${signature}`;
      if (dependencyWasObserved && readyState !== "loading" && stableState === previousStableState) {
        stableReads += 1;
      } else if (dependencyWasObserved && readyState !== "loading") {
        stableReads = 1;
        stableSince = Date.now();
      } else {
        stableReads = 0;
        stableSince = 0;
      }
      previousStableState = dependencyWasObserved ? stableState : "";
      if (dependencyWasObserved && stableReads >= 3 && Date.now() - stableSince >= 200) {
        await waitForUniqueSelectedEnabledOptionByVisibleText(
          current,
          "CUIT",
          "tipo de documento predeterminado del Consumidor Final",
          Math.max(1, deadline - Date.now()),
        );
        return;
      }
    } else {
      previousStableState = "";
      stableReads = 0;
      stableSince = 0;
    }
    await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  await assertNoArcaAccessFailure(page);
  throw new Error("ARCA no mostró una actualización estable del tipo de documento dependiente de la condición IVA.");
}

async function recipientDocumentTypeOptionsSignature(select: Locator): Promise<string> {
  return await select.locator("option").evaluateAll((elements) => elements.map((element) => {
    const option = element as HTMLOptionElement;
    const parentDisabled = option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled;
    return `${(option.textContent ?? "").trim()}\u0000${option.disabled || parentDisabled ? "1" : "0"}\u0000${option.selected ? "1" : "0"}`;
  }).join("\u0001"));
}

async function recipientDocumentTypeMutationRevision(page: Page): Promise<number> {
  return await page.evaluate(() => (globalThis as RecipientDocumentTypeMutationGlobal).__arcaRecipientDocumentTypeMutationState?.revision ?? 0).catch(() => 0);
}

async function stopObservingRecipientDocumentTypeDependency(
  page: Page,
  observation: RecipientDocumentTypeDependencyObservation,
): Promise<void> {
  page.off("framenavigated", observation.onFrameNavigated);
  await page.evaluate(() => {
    const scope = globalThis as RecipientDocumentTypeMutationGlobal;
    scope.__arcaRecipientDocumentTypeMutationState?.observer.disconnect();
    delete scope.__arcaRecipientDocumentTypeMutationState;
  }).catch(() => undefined);
  await observation.initialSelectHandle?.dispose().catch(() => undefined);
}

async function fillOperationDetail(page: Page, description: string, unitPrice: string, amountCents: number, unit: string | undefined, context?: FlowContext): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la carga del detalle y el importe");
  await fillFirstVisible([
    candidate(page.locator("#detalle_descripcion1"), "#detalle_descripcion1"),
    candidate(page.locator("[name='detalle_descripcion1']"), "name detalle_descripcion1"),
    candidate(page.getByRole("textbox", { name: /producto|servicio|descripción|detalle/i }), "textbox accesible de detalle"),
  ], description, "producto/servicio", context);
  await fillFirstVisible([
    candidate(page.locator("#detalle_cantidad1"), "#detalle_cantidad1"),
    candidate(page.locator("[name='detalle_cantidad1']"), "name detalle_cantidad1"),
    candidate(page.getByRole("textbox", { name: /^cant/i }), "textbox accesible cantidad"),
  ], "1", "cantidad", context);
  if (unit) {
    const unitSelect = await uniqueVisibleControl(page.locator("#detalle_medida1, select[name='detalle_medida1']"), "unidad de medida");
    await selectOptionContaining(unitSelect, unit);
  }
  await fillFirstVisible([
    candidate(page.locator("#detalle_precio1"), "#detalle_precio1"),
    candidate(page.locator("[name='detalle_precio1']"), "name detalle_precio1"),
    candidate(page.getByRole("textbox", { name: /precio.*unit/i }), "textbox accesible precio unitario"),
  ], unitPrice, "precio unitario", context);
  await page.keyboard.press("Tab").catch(() => undefined);
  return await measureArcaPerformance("prepare_total_ready", async () => await waitForCalculatedInvoiceTotal(page, amountCents));
}

export async function waitForCalculatedInvoiceTotal(page: Page, expectedCents: number, timeoutMs = 5000): Promise<Pick<InvoiceControlEvidence, "subtotal" | "total">> {
  assertOfficialArcaRcelUrl(page.url(), "la lectura del total calculado");
  if (!Number.isSafeInteger(expectedCents) || expectedCents < 0) throw new Error("El total esperado en centavos es inválido.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("El tiempo de espera del total calculado es inválido.");
  let subtotal: Locator;
  let total: Locator;
  try {
    subtotal = await exactCalculatedAmountControl(page, /^\s*Subtotal\s*:\s*\$?\s*$/i, "Subtotal");
    total = await exactCalculatedAmountControl(page, /^\s*Importe\s+Total\s*:\s*\$?\s*$/i, "Importe Total");
  } catch (error) {
    await assertNoArcaAccessFailure(page);
    throw error;
  }
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertOfficialArcaRcelUrl(page.url(), "la lectura del total calculado");
    const [subtotalValue, totalValue] = await Promise.all([subtotal.inputValue(), total.inputValue()]);
    if (parseArcaCalculatedAmount(subtotalValue) === expectedCents && parseArcaCalculatedAmount(totalValue) === expectedCents) {
      return { subtotal: subtotalValue.trim(), total: totalValue.trim() };
    }
    await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  await assertNoArcaAccessFailure(page);
  throw new Error("ARCA no mostró el subtotal y el importe total calculados que coincidan con el importe del job.");
}

async function exactCalculatedAmountControl(page: Page, labelPattern: RegExp, label: string): Promise<Locator> {
  const labels = page.getByText(labelPattern);
  const visibleLabels: Locator[] = [];
  for (let index = 0; index < await labels.count(); index += 1) {
    const current = labels.nth(index);
    if (await current.isVisible().catch(() => false)) visibleLabels.push(current);
  }
  if (visibleLabels.length !== 1) {
    throw new Error(`${label}: se esperaba una única etiqueta visible y se encontraron ${visibleLabels.length}.`);
  }

  const controls = visibleLabels[0]!.locator("xpath=ancestor::tr[1]//input[@readonly or @disabled or @aria-readonly='true']");
  const visibleControls: Locator[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const current = controls.nth(index);
    if (await current.isVisible().catch(() => false)) visibleControls.push(current);
  }
  if (visibleControls.length !== 1) {
    throw new Error(`${label}: se esperaba un único importe calculado en la misma fila y se encontraron ${visibleControls.length}.`);
  }
  return visibleControls[0]!;
}

function parseArcaCalculatedAmount(value: string): number | undefined {
  const compact = value.replace(/\s|\$/g, "").replace(/[^0-9,.-]/g, "");
  if (!/\d/.test(compact) || compact.startsWith("-")) return undefined;
  const separator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  const hasDecimals = separator >= 0 && compact.length - separator - 1 === 2;
  const whole = (hasDecimals ? compact.slice(0, separator) : compact).replace(/\D/g, "") || "0";
  const fraction = hasDecimals ? compact.slice(separator + 1).replace(/\D/g, "") : "00";
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export async function selectActivityIfNeeded(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la lectura de la actividad asociada");
  const activityControls = page.locator("select[name*='actividad' i], select[id*='actividad' i]");
  const visible = await visibleLocators(activityControls);
  if (visible.length === 0) {
    if (job.activity) throw new Error('El job define "activity", pero ARCA no mostró el control documentado de actividad.');
    return;
  }
  if (visible.length !== 1) throw new Error(`Actividad asociada: se esperaba un único control visible y se encontraron ${visible.length}.`);
  const select = visible[0];
  if (!select) return;
  if (job.activity) {
    await selectOptionContaining(select, job.activity);
    return;
  }
  const selected = select.locator("option:checked");
  if (await selected.count() !== 1) throw new Error("ARCA no mostró una selección verificable para Actividad Asociada.");
  const selectedText = ((await selected.textContent()) ?? "").trim();
  const selectedValue = await selected.evaluate((option) => (option as HTMLOptionElement).value);
  const blankSentinel = selectedValue === "" || selectedValue === "-1";
  if (!blankSentinel || !/^seleccionar(?:\.\.\.)?$/i.test(selectedText)) {
    throw new Error(`ARCA dejó preseleccionada una actividad no solicitada: ${selectedText || selectedValue}.`);
  }
}

export async function waitForRecipientAutofill(page: Page, timeoutMs = 10000): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la espera del autocompletado del receptor");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertOfficialArcaRcelUrl(page.url(), "la lectura del autocompletado del receptor");
    const businessName = (await page.locator("#razonsocialreceptor").inputValue().catch(() => "")).trim();
    if (businessName && await hasRecipientAddressControlReady(page)) {
      return;
    }

    await page.waitForTimeout(100);
  }

  throw new Error("ARCA no completó razón social y domicilio del receptor dentro del plazo seguro.");
}

async function hasRecipientAddressControlReady(page: Page): Promise<boolean> {
  assertOfficialArcaRcelUrl(page.url(), "la lectura del domicilio del receptor");
  const controls = page.locator("select[name*='domicilio' i], #domicilioreceptor");
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    const tagName = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    if (tagName === "select") {
      const options = (await control.locator("option").allTextContents())
        .map((value) => value.trim())
        .filter((value) => value && !/^seleccionar(?:\.\.\.)?$/i.test(value));
      if (options.length > 0) return true;
      continue;
    }
    if ((await control.inputValue().catch(() => "")).trim()) return true;
  }
  return false;
}

type CommercialAddressOption = {
  index: number;
  text: string;
  value: string | null;
};

export async function ensureCommercialAddress(page: Page, job: ResolvedInvoiceJob, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la selección del domicilio comercial");
  const addressSelects = await visibleLocators(page.locator(recipientCommercialAddressSelect));
  if (addressSelects.length === 0) {
    const visibleAddress = (await readRecipientCommercialAddress(page)).value;
    if (job.recipientCommercialAddress && !commercialAddressesMatch(visibleAddress, job.recipientCommercialAddress)) {
      throw new Error(`El domicilio comercial visible no coincide con el job. Esperado: ${job.recipientCommercialAddress}; visible: ${visibleAddress}.`);
    }
    return;
  }
  if (addressSelects.length !== 1) {
    throw new Error(`Domicilio comercial: se esperaba un único selector visible y se encontraron ${addressSelects.length}.`);
  }

  const select = addressSelects[0] as Locator;
  const options = await select.locator("option").evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: (element.textContent ?? "").trim(),
    value: element.getAttribute("value"),
  }))) as CommercialAddressOption[];
  const selectableOptions = options.filter((option) => option.text && !isCommercialAddressPlaceholder(option.text, option.value));
  const realAddressOptions = selectableOptions.filter((option) => !isOtherCommercialAddressOption(option.text));
  const otherOptions = selectableOptions.filter((option) => isOtherCommercialAddressOption(option.text));

  if (job.recipientCommercialAddress) {
    const requestedAddress = job.recipientCommercialAddress;
    const matches = realAddressOptions.filter((option) => commercialAddressesMatch(option.text, requestedAddress));
    if (matches.length > 1) {
      throw new Error(`El domicilio indicado coincide con más de una opción de ARCA. Opciones: ${matches.map((option) => option.text).join(" | ")}.`);
    }
    if (matches.length === 1) {
      await selectCommercialAddressOption(select, matches[0] as CommercialAddressOption);
      await verifyCommercialAddress(page, requestedAddress);
      return;
    }

    if (otherOptions.length !== 1) {
      const detail = otherOptions.length === 0 ? "no hay una opción Otro/Otra" : `hay ${otherOptions.length} opciones Otro/Otra`;
      throw new Error(`El domicilio indicado no coincide con ninguna opción exacta de ARCA y ${detail}.`);
    }
    await selectCommercialAddressOption(select, otherOptions[0] as CommercialAddressOption);
    await fillOtherCommercialAddress(page, requestedAddress);
    await verifyCommercialAddress(page, requestedAddress);
    return;
  }

  if (realAddressOptions.length !== 1) {
    const optionsText = realAddressOptions.map((option) => option.text).join(" | ") || "ninguna";
    throw new Error(`ARCA debe mostrar un único domicilio comercial cuando el job no lo especifica. Coincidencias: ${realAddressOptions.length}. Opciones: ${optionsText}.`);
  }
  const defaultAddress = realAddressOptions[0] as CommercialAddressOption;
  await selectCommercialAddressOption(select, defaultAddress);
  await verifyCommercialAddress(page, defaultAddress.text);
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "domicilio comercial", candidate: recipientCommercialAddressSelect, result: "used", visibleCount: 1 });
}

async function requiredInteractiveText(context: FlowContext | undefined, message: string): Promise<string> {
  if (context?.interactive === false) {
    throw new Error(`${message}. Este dato debe estar definido en el job para usar la ruta rapida.`);
  }

  return await askText(message);
}

async function fillOtherCommercialAddress(page: Page, address: string): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la carga de otro domicilio comercial");
  const input = await waitForUniqueVisibleAddressInput(page, "domicilio comercial personalizado");
  await input.fill(address);
}

async function selectCommercialAddressOption(select: Locator, option: CommercialAddressOption): Promise<void> {
  await select.selectOption({ index: option.index });
}

async function verifyCommercialAddress(page: Page, expected: string): Promise<void> {
  const visibleAddress = (await readRecipientCommercialAddress(page)).value;
  if (!commercialAddressesMatch(visibleAddress, expected)) {
    throw new Error(`El domicilio comercial visible no coincide con el job. Esperado: ${expected}; visible: ${visibleAddress}.`);
  }
}

async function checkSaleCondition(page: Page, saleCondition: string, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la selección de la condición de venta");
  const labelPattern = saleConditionOtherPattern(saleCondition);
  const checkbox = page.getByRole("checkbox", { name: labelPattern });
  const control = await uniqueVisibleControl(checkbox, `condición de venta ${saleCondition}`);
  await control.check();
  await context?.guided?.recordSelectorAttempt({ action: "click", description: "condición de venta", candidate: `checkbox accesible exacto ${saleCondition}`, result: "used", visibleCount: 1 });
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function saleConditionOtherPattern(value: string): RegExp {
  if (/^otr[oa]$/i.test(value.trim())) {
    return /^otr[oa]$/i;
  }

  return new RegExp(`^${escapeRegExp(value)}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatArcaUnitPrice(amount: number): string {
  return amount.toFixed(2);
}

export async function selectInitialVoucherData(page: Page, pointOfSale: string, voucherType: string, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la selección del punto de venta y comprobante");
  const pointOfSaleSelect = await uniqueVisibleControl(page.locator("#puntodeventa, select[name='puntodeventa' i]"), "punto de venta");
  const initialVoucherTypeSelect = await uniqueVisibleControl(page.locator(initialVoucherTypeSelector), "tipo de comprobante");
  const initialVoucherOptions = await readVoucherOptions(initialVoucherTypeSelect);
  let navigationRevision = 0;
  const observeMainFrameNavigation = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame()) navigationRevision += 1;
  };
  page.on("framenavigated", observeMainFrameNavigation);
  const dependencyObservation: VoucherDependencyObservation = {
    initialNavigationRevision: navigationRevision,
    initialPointOfSaleWasTarget: await selectedPointOfSaleMatches(pointOfSaleSelect, pointOfSale),
    initialOnlyPlaceholder: meaningfulVoucherOptions(initialVoucherOptions).length === 0,
    initialOptionsSignature: voucherOptionsSignature(initialVoucherOptions),
    initialSelectHandle: await initialVoucherTypeSelect.elementHandle(),
  };
  await installVoucherMutationObserver(initialVoucherTypeSelect);
  try {
    await selectOptionContaining(pointOfSaleSelect, pointOfSale);
    const options = await measureArcaPerformance(
      "prepare_voucher_options",
      async () => await waitForStableVoucherOptions(page, pointOfSale, dependencyObservation, () => navigationRevision),
    );
    const normalizedVoucherType = normalizeExactOptionText(voucherType);
    if (normalizedVoucherType !== normalizeExactOptionText("Factura C")) {
      throw new Error(`La capacidad actual exige Factura C y recibió un tipo distinto. No se continuará.`);
    }
    const enabledMatches = options.filter((option) => !option.disabled && normalizeExactOptionText(option.text) === normalizedVoucherType);
    if (enabledMatches.length !== 1) {
      throw unavailableVoucherTypeError(pointOfSale, options);
    }

    const voucherTypeSelect = await uniqueVisibleControl(page.locator(initialVoucherTypeSelector), "tipo de comprobante");
    await voucherTypeSelect.selectOption({ index: (enabledMatches[0] as VoucherOption).index });
    await waitForArcaDocumentReady(page);
    await assertSelectedInitialVoucherData(page, pointOfSale, voucherType);
  } finally {
    await uninstallVoucherMutationObserver(page);
    await dependencyObservation.initialSelectHandle?.dispose().catch(() => undefined);
    page.off("framenavigated", observeMainFrameNavigation);
  }
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "punto de venta", candidate: "#puntodeventa", result: "used", visibleCount: 1 });
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "tipo de comprobante", candidate: "#universocomprobante / name=universoComprobante", result: "used", visibleCount: 1 });
}

type VoucherOption = {
  index: number;
  text: string;
  value: string;
  disabled: boolean;
  selected: boolean;
};

type VoucherDependencyObservation = {
  initialNavigationRevision: number;
  initialPointOfSaleWasTarget: boolean;
  initialOnlyPlaceholder: boolean;
  initialOptionsSignature: string;
  initialSelectHandle: Awaited<ReturnType<Locator["elementHandle"]>>;
};

type VoucherMutationState = {
  revision: number;
  observer: MutationObserver;
};

type VoucherMutationGlobal = typeof globalThis & {
  __arcaVoucherMutationState?: VoucherMutationState;
};

async function waitForStableVoucherOptions(
  page: Page,
  pointOfSale: string,
  observation: VoucherDependencyObservation,
  navigationRevision: () => number,
  timeoutMs = 10000,
): Promise<VoucherOption[]> {
  const deadline = Date.now() + timeoutMs;
  let observedNavigationRevision = navigationRevision();
  let previousStableState = "";
  let stableSince = 0;
  let stableReads = 0;
  let lastOptions: VoucherOption[] = [];

  while (Date.now() < deadline) {
    assertOfficialArcaRcelUrl(page.url(), "la espera de tipos de comprobante dependientes del punto de venta");
    const currentNavigationRevision = navigationRevision();
    if (currentNavigationRevision !== observedNavigationRevision) {
      observedNavigationRevision = currentNavigationRevision;
      previousStableState = "";
      stableSince = 0;
      stableReads = 0;
    }

    const pointOfSaleControls = await visibleLocators(page.locator("#puntodeventa, select[name='puntodeventa' i]")).catch(() => []);
    const voucherTypeControls = await visibleLocators(page.locator(initialVoucherTypeSelector)).catch(() => []);
    if (pointOfSaleControls.length > 1 || voucherTypeControls.length > 1) {
      throw new Error("ARCA mostró controles ambiguos para punto de venta o tipo de comprobante.");
    }
    const currentPointOfSale = pointOfSaleControls[0];
    const currentVoucherType = voucherTypeControls[0];
    if (currentPointOfSale && currentVoucherType && await selectedPointOfSaleMatches(currentPointOfSale, pointOfSale)) {
      const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
      const options = await readVoucherOptions(currentVoucherType).catch(() => []);
      lastOptions = options;
      const meaningful = meaningfulVoucherOptions(options);
      const signature = voucherOptionsSignature(options);
      const selectWasReplaced = await currentVoucherType
        .evaluate((element, initialElement) => element !== initialElement, observation.initialSelectHandle)
        .catch(() => true);
      const mutationRevision = await voucherOptionsMutationRevision(page);
      const dependencyWasObserved = currentNavigationRevision !== observation.initialNavigationRevision
        || mutationRevision > 0
        || selectWasReplaced
        || signature !== observation.initialOptionsSignature
        || observation.initialPointOfSaleWasTarget
        || observation.initialOnlyPlaceholder;
      if (!dependencyWasObserved) {
        previousStableState = "";
        stableSince = 0;
        stableReads = 0;
      } else {
        const stableState = `${currentNavigationRevision}\u0000${mutationRevision}\u0000${selectWasReplaced ? "1" : "0"}\u0000${signature}`;
        if (readyState !== "loading" && meaningful.length > 0 && stableState === previousStableState) {
          stableReads += 1;
        } else {
          stableReads = 1;
          stableSince = Date.now();
        }
        previousStableState = stableState;
      }
      if (dependencyWasObserved && meaningful.length > 0 && stableReads >= 3 && Date.now() - stableSince >= 200) {
        await assertNoArcaAccessFailure(page);
        return options;
      }
    } else {
      previousStableState = "";
      stableSince = 0;
      stableReads = 0;
    }
    await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  await assertNoArcaAccessFailure(page);
  throw unavailableVoucherTypeError(pointOfSale, lastOptions);
}

async function installVoucherMutationObserver(select: Locator): Promise<void> {
  await select.evaluate((element) => {
    const scope = globalThis as VoucherMutationGlobal;
    scope.__arcaVoucherMutationState?.observer.disconnect();
    const state = { revision: 0 } as VoucherMutationState;
    const observer = new MutationObserver((records) => {
      const changedOptions = records.some((record) => record.type === "childList"
        || record.type === "characterData"
        || record.target instanceof HTMLOptionElement
        || record.target instanceof HTMLOptGroupElement);
      if (changedOptions) state.revision += 1;
    });
    state.observer = observer;
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["disabled", "label", "value"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    scope.__arcaVoucherMutationState = state;
  });
}

async function voucherOptionsMutationRevision(page: Page): Promise<number> {
  return await page.evaluate(() => (globalThis as VoucherMutationGlobal).__arcaVoucherMutationState?.revision ?? 0).catch(() => 0);
}

async function uninstallVoucherMutationObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as VoucherMutationGlobal;
    scope.__arcaVoucherMutationState?.observer.disconnect();
    delete scope.__arcaVoucherMutationState;
  }).catch(() => undefined);
}

async function readVoucherOptions(select: Locator): Promise<VoucherOption[]> {
  return await select.locator("option").evaluateAll((elements) => elements.map((element, index) => {
    const option = element as HTMLOptionElement;
    const parentDisabled = option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled;
    return {
      index,
      text: (option.textContent ?? "").trim(),
      value: option.value,
      disabled: option.disabled || parentDisabled,
      selected: option.selected,
    };
  }));
}

function meaningfulVoucherOptions(options: VoucherOption[]): VoucherOption[] {
  return options.filter((option) => {
    const sentinel = option.value === "" || option.value === "-1";
    return !(sentinel && (option.text.trim() === "" || /^seleccionar(?:\.*)?$/i.test(option.text)));
  });
}

function voucherOptionsSignature(options: VoucherOption[]): string {
  return options.map((option) => `${option.value}\u0000${option.text}\u0000${option.disabled ? "1" : "0"}`).join("\u0001");
}

function unavailableVoucherTypeError(pointOfSale: string, options: VoucherOption[]): Error {
  const available = meaningfulVoucherOptions(options)
    .map((option) => `${option.text || option.value}${option.disabled ? " (deshabilitada)" : ""}`)
    .join(" | ") || "ninguno";
  return new Error(`El punto de venta ${pointOfSale} no ofrece una única opción habilitada Factura C. Tipos disponibles: ${available}. No se continuará.`);
}

async function assertSelectedInitialVoucherData(page: Page, pointOfSale: string, voucherType: string): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la relectura de punto de venta y tipo de comprobante");
  const pointOfSaleSelect = await uniqueVisibleControl(page.locator("#puntodeventa, select[name='puntodeventa' i]"), "punto de venta");
  const voucherTypeSelect = await uniqueVisibleControl(page.locator(initialVoucherTypeSelector), "tipo de comprobante");
  if (!await selectedPointOfSaleMatches(pointOfSaleSelect, pointOfSale)) {
    throw new Error("ARCA no conservó el punto de venta solicitado después de cargar los tipos de comprobante.");
  }
  const selectedVoucherOptions = (await readVoucherOptions(voucherTypeSelect)).filter((option) => option.selected);
  if (selectedVoucherOptions.length !== 1
    || selectedVoucherOptions[0]?.disabled
    || normalizeExactOptionText(selectedVoucherOptions[0]?.text ?? "") !== normalizeExactOptionText(voucherType)) {
    throw new Error("ARCA no conservó una selección única y habilitada de Factura C.");
  }
}

async function selectedPointOfSaleMatches(select: Locator, expected: string): Promise<boolean> {
  const options = await readVoucherOptions(select);
  const selected = options.filter((option) => option.selected);
  const matches = options.filter((option) => pointOfSaleOptionMatches(option, expected));
  if (selected.length !== 1 || matches.length !== 1) return false;
  const option = matches[0] as VoucherOption;
  return option.selected && !option.disabled;
}

function pointOfSaleOptionMatches(option: VoucherOption, expected: string): boolean {
  const normalizedExpected = normalizeExactOptionText(expected);
  const normalizedText = normalizeExactOptionText(option.text).replace(/\s+/g, "");
  const normalizedValue = normalizeExactOptionText(option.value);
  return normalizedValue === normalizedExpected
    || normalizedText === normalizedExpected
    || (/^[0-9]+$/u.test(normalizedExpected) && new RegExp(`^${escapeRegExp(normalizedExpected)}(?:\\D|$)`, "u").test(normalizedText));
}

function normalizeExactOptionText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function waitForInvoiceScreen(page: Page, control: ReturnType<Page["locator"]>, description: string, context?: FlowContext, timeoutMs = 10000): Promise<void> {
  await waitForArcaDocumentReady(page, timeoutMs);
  await pauseIfCaptcha(page, context);
  assertOfficialArcaRcelUrl(page.url(), `la espera de ${description}`);
  try {
    await control.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    await assertNoArcaAccessFailure(page);
    await pauseIfCaptcha(page, context);
    throw new Error(`ARCA no mostró la pantalla esperada de ${description}.`);
  }
  await assertNoArcaAccessFailure(page);
  assertOfficialArcaRcelUrl(page.url(), `la validación de ${description}`);
}

async function visibleLocators(locator: ReturnType<Page["locator"]>): Promise<Array<ReturnType<Page["locator"]>>> {
  assertOfficialArcaRcelUrl(locator.page().url(), "la lectura de controles fiscales");
  const result: Array<ReturnType<Page["locator"]>> = [];
  for (let index = 0; index < await locator.count(); index += 1) if (await locator.nth(index).isVisible().catch(() => false)) result.push(locator.nth(index));
  return result;
}

async function uniqueVisibleControl(locator: ReturnType<Page["locator"]>, description: string): Promise<ReturnType<Page["locator"]>> {
  assertOfficialArcaRcelUrl(locator.page().url(), `la lectura de ${description}`);
  const visible = await visibleLocators(locator);
  if (visible.length !== 1) throw new Error(`${description}: se esperaba un único control visible y se encontraron ${visible.length}.`);
  return visible[0] as ReturnType<Page["locator"]>;
}
