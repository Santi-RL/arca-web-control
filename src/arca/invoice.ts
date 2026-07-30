import { Locator, Page } from "playwright";
import { ResolvedInvoiceJob } from "../types.js";
import { formatDateForArca } from "../utils/date.js";
import { askText } from "../io/prompt.js";
import { pauseIfCaptcha } from "./captcha.js";
import { FlowContext } from "./flowContext.js";
import { assertNoArcaAccessFailure, candidate, clickFirstVisible, fillFirstVisible, selectOptionContaining, waitForArcaDocumentReady } from "./pageHelpers.js";
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

  await context?.guided?.checkpoint(page, {
    title: "Receptor cargado",
    expected: `Debe verse el CUIT receptor ${onlyDigits(job.recipientCuit)}${job.recipientName ? ` (${job.recipientName})` : ""}${job.recipientVatCondition ? `, condicion IVA ${job.recipientVatCondition}` : ""}${job.saleCondition ? ` y condicion de venta ${job.saleCondition}` : ""}. Razon social y domicilio deben estar autocompletados por ARCA.`,
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
    await fillOperationDetail(page, job.description, amount, job.amountCents, job.unit, context);
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
  if (job.recipientVatCondition) {
    const vat = await uniqueVisibleControl(page.locator("#idivareceptor, select[name*='ivareceptor' i]"), "condición IVA receptor");
    await selectOptionContaining(vat, job.recipientVatCondition);
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

async function fillOperationDetail(page: Page, description: string, unitPrice: string, amountCents: number, unit: string | undefined, context?: FlowContext): Promise<void> {
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
  await measureArcaPerformance("prepare_total_ready", async () => await waitForCalculatedInvoiceTotal(page, amountCents));
}

export async function waitForCalculatedInvoiceTotal(page: Page, expectedCents: number, timeoutMs = 5000): Promise<void> {
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
    if (parseArcaCalculatedAmount(subtotalValue) === expectedCents && parseArcaCalculatedAmount(totalValue) === expectedCents) return;
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

async function selectInitialVoucherData(page: Page, pointOfSale: string, voucherType: string, context?: FlowContext): Promise<void> {
  assertOfficialArcaRcelUrl(page.url(), "la selección del punto de venta y comprobante");
  const pointOfSaleSelect = await uniqueVisibleControl(page.locator("#puntodeventa, select[name='puntodeventa' i]"), "punto de venta");
  await selectOptionContaining(pointOfSaleSelect, pointOfSale);
  const voucherTypeSelect = await uniqueVisibleControl(page.locator(initialVoucherTypeSelector), "tipo de comprobante");
  await measureArcaPerformance("prepare_voucher_options", async () => await waitForSelectOptions(voucherTypeSelect, 2));
  await selectOptionContaining(voucherTypeSelect, voucherType);
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "punto de venta", candidate: "#puntodeventa", result: "used", visibleCount: 1 });
  await context?.guided?.recordSelectorAttempt({ action: "select", description: "tipo de comprobante", candidate: "#universocomprobante / name=universoComprobante", result: "used", visibleCount: 1 });
}

async function waitForSelectOptions(locator: ReturnType<Page["locator"]>, minimumOptions: number): Promise<void> {
  assertOfficialArcaRcelUrl(locator.page().url(), "la lectura de tipos de comprobante");
  await locator.locator("option").nth(minimumOptions - 1).waitFor({ state: "attached", timeout: 10000 }).catch(() => undefined);
  const optionCount = await locator.locator("option").count().catch(() => 0);
  if (optionCount >= minimumOptions) return;
  const options = await locator.locator("option").allTextContents().catch(() => []);
  throw new Error(`El select no cargo opciones suficientes. Opciones visibles: ${options.map((option) => option.trim()).join(" | ")}`);
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
