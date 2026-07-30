import { Page } from "playwright";
import { ArcaCredentials, RuntimeConfig } from "../types.js";
import { pauseIfCaptcha } from "./captcha.js";
import { FlowContext } from "./flowContext.js";
import { continueArcaAccessIfRequested } from "./login.js";
import { assertNoArcaAccessFailure, candidate, clickFirstVisible, type ElementCandidate, fillFirstVisible, waitForAnyVisible, waitForArcaDocumentReady, waitForPageSettled } from "./pageHelpers.js";
import { knownSystemId, serviceNameToRegExp } from "./services.js";
import { measureArcaPerformance } from "./performance.js";
import {
  assertOfficialArcaAuthUrl,
  assertOfficialArcaPortalUrl,
  assertOfficialArcaRcelUrl,
  isOfficialArcaAuthUrl,
  isOfficialArcaRcelUrl,
} from "./officialUrls.js";

const comprobantesEnLineaText = /comprobantes en l[ií]nea/i;
const comprobantesSearchResultText = /comprobantes en l[ií]nea[\s\S]*sistema de emisi[oó]n de comprobantes electr[oó]nicos/i;
const comprobantesDescriptionText = /sistema de emisi[oó]n de comprobantes electr[oó]nicos/i;
const searchText = "comprobantes en linea";

export async function openComprobantesEnLinea(page: Page, context?: FlowContext): Promise<Page> {
  console.log("Buscando servicio Comprobantes en Linea...");
  await waitForArcaDocumentReady(page);
  await pauseIfCaptcha(page, context);
  assertOfficialArcaPortalUrl(page.url(), "la búsqueda de Comprobantes en Línea");

  await searchService(page, searchText, context);

  await context?.guided?.checkpoint(page, {
    title: "Resultado de busqueda de Comprobantes en Linea",
    expected: "Debe verse el resultado desplegado 'Comprobantes en linea' del buscador global, no solo un servicio reciente.",
    nextAction: "El sistema abrira el resultado del buscador.",
  });

  const pagesBefore = new Set(page.context().pages());
  let openedFromSearch = true;
  try {
    await clickSearchResult(page, context);
  } catch (error) {
    if (!/No se encontro un elemento visible/i.test(error instanceof Error ? error.message : String(error))) throw error;
    openedFromSearch = false;
  }

  if (!openedFromSearch) {
    await openFromAllServices(page, context);
  }

  const servicePage = await measureArcaPerformance("prepare_service_open", async () => await waitForComprobantesPage(page, pagesBefore));
  await waitForArcaDocumentReady(servicePage);
  await pauseIfCaptcha(servicePage, context);
  assertOfficialArcaRcelUrl(servicePage.url(), "la adopción de la pestaña RCEL");
  await context?.guided?.checkpoint(servicePage, {
    title: "Comprobantes en Linea abierto",
    expected: "Debe verse la pantalla del servicio Comprobantes en Linea.",
    nextAction: "El sistema seleccionara el emisor/representado si ARCA lo solicita.",
  });

  return servicePage;
}

export async function openPortalService(page: Page, serviceName: string, context?: FlowContext): Promise<Page> {
  console.log(`Buscando servicio ${serviceName}...`);
  await waitForPageSettled(page);
  await pauseIfCaptcha(page, context);

  const serviceText = serviceNameToRegExp(serviceName);
  const pagesBefore = new Set(page.context().pages());
  const initialUrl = page.url();

  await searchService(page, serviceName, context);

  await context?.guided?.checkpoint(page, {
    title: `Resultado de busqueda de ${serviceName}`,
    expected: `Debe verse un resultado clickeable para ${serviceName}.`,
    nextAction: "El sistema abrira el resultado del buscador.",
  });

  assertOfficialArcaPortalUrl(page.url(), "la apertura del servicio buscado");
  await clickFirstVisible([
    candidate(page.getByRole("link", { name: serviceText }), `resultado link ${serviceName}`),
    candidate(page.getByRole("button", { name: serviceText }), `resultado boton ${serviceName}`),
    candidate(page.locator(".search-results, .resultados, [class*='result']").getByText(serviceText), `texto ${serviceName} dentro de resultados`),
    candidate(page.getByText(serviceText), `texto ${serviceName}`),
  ], `resultado del buscador ${serviceName}`, context);

  const servicePage = await waitForOpenedServicePage(page, pagesBefore, initialUrl, serviceText);
  await waitForPageSettled(servicePage);
  await pauseIfCaptcha(servicePage, context);

  await context?.guided?.checkpoint(servicePage, {
    title: `${serviceName} abierto`,
    expected: `Debe verse la pantalla del servicio ${serviceName}.`,
    nextAction: "El sistema quedara en handoff para operacion asistida.",
  });

  return servicePage;
}

export async function openArcaService(page: Page, serviceName: string, config: RuntimeConfig, credentials: ArcaCredentials, context?: FlowContext): Promise<Page> {
  const directSystem = knownSystemId(serviceName);
  let servicePage = page;

  if (directSystem) {
    console.log(`Abriendo servicio ${serviceName} por URL de sistema conocida...`);
    assertOfficialArcaAuthUrl(config.loginUrl, "la apertura directa de un servicio");
    const systemUrl = new URL(config.loginUrl);
    systemUrl.search = "";
    systemUrl.hash = "";
    systemUrl.searchParams.set("action", "SYSTEM");
    systemUrl.searchParams.set("system", directSystem);
    await servicePage.goto(systemUrl.toString(), { waitUntil: "domcontentloaded" });
  } else {
    servicePage = await openPortalService(servicePage, serviceName, context);
  }

  if (isOfficialArcaAuthUrl(servicePage.url())) {
    await continueArcaAccessIfRequested(servicePage, credentials, context);
  }

  await waitForPageSettled(servicePage);
  await servicePage.bringToFront().catch(() => undefined);
  return servicePage;
}

async function searchService(page: Page, value: string, context?: FlowContext, options: { optional?: boolean } = {}): Promise<void> {
  assertOfficialArcaPortalUrl(page.url(), "la búsqueda de servicios");
  const fields = searchFieldCandidates(page);
  try {
    await waitForAnyVisible(fields, "buscador de trámites y servicios", options.optional ? 1500 : 20000);
  } catch (error) {
    await assertNoArcaAccessFailure(page);
    if (options.optional && /No apareció un elemento visible/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }

  assertOfficialArcaPortalUrl(page.url(), "la escritura en el buscador de servicios");
  await fillFirstVisible(fields, value, "buscador de tramites y servicios", context);
  await measureArcaPerformance("prepare_service_search_result", async () => {
    try {
      await waitForAnyVisible(searchResultCandidates(page, value), `resultado exacto de ${value}`, 3000);
    } catch (error) {
      if (!/No apareció un elemento visible/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  });
}

function searchFieldCandidates(page: Page): ElementCandidate[] {
  return [
    candidate(page.getByRole("combobox", { name: /buscador|buscar/i }), "combobox accesible del buscador"),
    candidate(page.locator("input[type='search']"), "input type search del portal"),
    candidate(page.getByPlaceholder(/busc[aá].*tr[aá]mites|qu[eé] necesit[aá]s|buscar/i), "campo buscador por placeholder"),
    candidate(page.getByLabel(/buscar|busc[aá].*tr[aá]mites/i), "campo buscador por label"),
  ];
}

function searchResultCandidates(page: Page, value: string): ElementCandidate[] {
  const serviceText = serviceNameToRegExp(value);
  if (comprobantesEnLineaText.test(value)) {
    return comprobantesSearchCandidates(page);
  }
  const results = searchResultsContainer(page);
  return [
    candidate(results.getByRole("link", { name: serviceText }), `resultado link ${value}`),
    candidate(results.getByRole("button", { name: serviceText }), `resultado botón ${value}`),
    candidate(results.getByText(serviceText), `texto ${value} dentro de resultados`),
  ];
}

async function clickSearchResult(page: Page, context?: FlowContext): Promise<void> {
  assertOfficialArcaPortalUrl(page.url(), "la apertura de Comprobantes en Línea");
  await clickFirstVisible(comprobantesSearchCandidates(page), "resultado del buscador Comprobantes en Linea", context);
}

function comprobantesSearchCandidates(page: Page): ElementCandidate[] {
  const results = searchResultsContainer(page);
  return [
    candidate(page.getByRole("link", { name: comprobantesSearchResultText }), "link de resultado con nombre y descripción de Comprobantes en Línea"),
    candidate(page.getByRole("button", { name: comprobantesSearchResultText }), "botón de resultado con nombre y descripción de Comprobantes en Línea"),
    candidate(results.getByRole("link", { name: comprobantesEnLineaText }), "link Comprobantes en Línea dentro del listado de resultados"),
    candidate(results.getByRole("button", { name: comprobantesEnLineaText }), "botón Comprobantes en Línea dentro del listado de resultados"),
    candidate(results.getByText(comprobantesDescriptionText), "descripción de Comprobantes en Línea dentro del listado de resultados"),
  ];
}

function searchResultsContainer(page: Page): ReturnType<Page["locator"]> {
  return page.locator(".search-results, .resultados, [class*='result'], [role='listbox'], [role='menu']");
}

async function openFromAllServices(page: Page, context?: FlowContext): Promise<void> {
  await context?.guided?.checkpoint(page, {
    title: "Buscador sin resultado clickeable",
    expected: "No se encontro un resultado clickeable confiable; se usara Ver todos como respaldo.",
    nextAction: "El sistema abrira Ver todos y buscara Comprobantes en Linea en la lista completa.",
  });

  assertOfficialArcaPortalUrl(page.url(), "la apertura de la lista completa de servicios");
  await clickFirstVisible([
    candidate(page.getByRole("link", { name: /ver todos/i }), "link Ver todos"),
    candidate(page.getByRole("button", { name: /ver todos/i }), "boton Ver todos"),
    candidate(page.getByText(/ver todos/i), "texto Ver todos"),
  ], "Ver todos", context);
  await waitForPageSettled(page);
  await pauseIfCaptcha(page, context);
  assertOfficialArcaPortalUrl(page.url(), "la búsqueda en la lista completa de servicios");

  await searchService(page, searchText, context, { optional: true });
  await context?.guided?.checkpoint(page, {
    title: "Lista completa de servicios",
    expected: "Debe verse Comprobantes en Linea dentro de la lista completa o filtrada.",
    nextAction: "El sistema abrira Comprobantes en Linea desde la lista completa.",
  });

  assertOfficialArcaPortalUrl(page.url(), "la apertura de Comprobantes en Línea desde la lista completa");
  await clickFirstVisible([
    candidate(page.getByRole("link", { name: comprobantesEnLineaText }), "link Comprobantes en Linea en lista completa"),
    candidate(page.getByRole("button", { name: comprobantesEnLineaText }), "boton Comprobantes en Linea en lista completa"),
    candidate(page.getByText(comprobantesEnLineaText), "texto Comprobantes en Linea en lista completa"),
  ], "Comprobantes en Linea desde Ver todos", context);
}

async function waitForOpenedServicePage(originalPage: Page, pagesBefore: Set<Page>, initialUrl: string, titleOrText: RegExp): Promise<Page> {
  const context = originalPage.context();
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    for (const candidatePage of context.pages()) {
      const url = candidatePage.url();
      const title = await candidatePage.title().catch(() => "");
      const body = await candidatePage.locator("body").innerText({ timeout: 1000 }).catch(() => "");

      if (!pagesBefore.has(candidatePage) && (url !== "about:blank" || titleOrText.test(title) || titleOrText.test(body))) {
        await candidatePage.bringToFront().catch(() => undefined);
        return candidatePage;
      }

      if (candidatePage === originalPage && originalPage.url() !== initialUrl) {
        return originalPage;
      }
    }

    await originalPage.waitForTimeout(250);
  }

  return originalPage;
}

export async function waitForComprobantesPage(originalPage: Page, pagesBefore = new Set<Page>([originalPage]), timeoutMs = 10000): Promise<Page> {
  const context = originalPage.context();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const candidatePage of context.pages()) {
      const url = candidatePage.url();
      if (candidatePage !== originalPage && !pagesBefore.has(candidatePage) && isOfficialArcaRcelUrl(url)) {
        await candidatePage.bringToFront().catch(() => undefined);
        return candidatePage;
      }
    }

    if (isOfficialArcaRcelUrl(originalPage.url())) {
      return originalPage;
    }

    await originalPage.waitForTimeout(250);
  }

  throw new Error("No se pudo detectar la pestana de Comprobantes en Linea despues de abrir el servicio.");
}

export async function selectRepresentedIssuer(page: Page, issuerCuit: string, issuerName: string | undefined, context?: FlowContext): Promise<void> {
  console.log("Seleccionando emisor/representado si ARCA lo solicita...");
  await waitForArcaDocumentReady(page);
  assertOfficialArcaRcelUrl(page.url(), "la lectura del selector de representado");

  const requiresIssuerSelection = await page.getByText(/seleccione la empresa|empresa a representar/i).first().isVisible().catch(() => false);
  if (requiresIssuerSelection) {
    const exactName = issuerName ? new RegExp(`^\\s*${escapeRegExp(issuerName)}\\s*$`, "i") : undefined;
    const cuitPattern = embeddedCuitPattern(issuerCuit);
    const issuerByCuit = page.getByText(cuitPattern);
    const issuerByName = exactName ? page.getByText(exactName) : page.locator("__never__");
    const issuerButtonByCuit = page.getByRole("button", { name: cuitPattern });
    const issuerButtonByName = exactName ? page.getByRole("button", { name: exactName }) : page.locator("__never__");

    await context?.guided?.checkpoint(page, {
      title: "Emisor encontrado",
      expected: `Debe verse el emisor correcto para ${issuerName ?? issuerCuit}.`,
      nextAction: "El sistema seleccionara ese emisor.",
    });

    assertOfficialArcaRcelUrl(page.url(), "la selección del representado");
    await clickFirstVisible([
      candidate(issuerButtonByCuit, `botón del CUIT emisor ${issuerCuit}`),
      candidate(issuerByCuit, `texto CUIT emisor ${issuerCuit}`),
      ...(issuerName ? [candidate(issuerButtonByName, `botón exacto del emisor ${issuerName}`)] : []),
      ...(issuerName ? [candidate(issuerByName, `texto exacto del emisor ${issuerName}`)] : []),
    ], "emisor/representado", context);
    await waitForArcaDocumentReady(page);
    assertOfficialArcaRcelUrl(page.url(), "la validación posterior del representado");

    if (await page.getByText(/seleccione la empresa|empresa a representar/i).first().isVisible().catch(() => false)) {
      throw new Error("La seleccion del emisor no avanzo: sigue visible la pantalla de empresa a representar.");
    }
    const continueButton = page.getByRole("button", { name: /continuar|aceptar|seleccionar/i });
    if (await continueButton.first().isVisible().catch(() => false)) {
      assertOfficialArcaRcelUrl(page.url(), "la confirmación del representado");
      await continueButton.first().click();
      await waitForArcaDocumentReady(page);
      assertOfficialArcaRcelUrl(page.url(), "la pantalla posterior al representado");
    }
  }

  await pauseIfCaptcha(page, context);
  await context?.guided?.checkpoint(page, {
    title: "Emisor seleccionado",
    expected: "Debe verse el servicio listo para generar comprobantes con el emisor correcto.",
    nextAction: "El sistema entrara a la generacion de un comprobante.",
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function embeddedCuitPattern(value: string): RegExp {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits)) throw new Error("El CUIT del emisor debe tener once dígitos.");
  const prefix = digits.slice(0, 2);
  const body = digits.slice(2, 10);
  const verifier = digits.slice(10);
  return new RegExp(`(?<!\\d)${prefix}-?${body}-?${verifier}(?!\\d)`, "i");
}
