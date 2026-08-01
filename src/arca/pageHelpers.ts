import { Locator, Page } from "playwright";
import { FlowContext } from "./flowContext.js";

type NamedElementCandidate = {
  name: string;
  locator: Locator;
};

export type ElementCandidate = Locator | NamedElementCandidate;

function isNamedCandidate(candidate: ElementCandidate): candidate is NamedElementCandidate {
  const possible = candidate as Partial<NamedElementCandidate>;
  return typeof possible.name === "string" && typeof possible.locator === "object";
}

function normalizeCandidate(candidate: ElementCandidate, index: number): { name: string; locator: Locator } {
  if (isNamedCandidate(candidate)) {
    return candidate;
  }

  return {
    name: `candidate-${index + 1}`,
    locator: candidate,
  };
}

export function candidate(locator: Locator, name: string): ElementCandidate {
  return { locator, name };
}

async function visibleMatches(locator: Locator): Promise<{ count: number; first?: Locator }> {
  const total = await locator.count().catch(() => 0);
  let count = 0;
  let first: Locator | undefined;

  for (let index = 0; index < Math.min(total, 10); index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) {
      count += 1;
      first ??= current;
    }
  }

  return { count, first };
}

export async function clickFirstVisible(candidates: ElementCandidate[], description: string, context?: FlowContext): Promise<void> {
  for (const rawCandidate of candidates) {
    const current = normalizeCandidate(rawCandidate, candidates.indexOf(rawCandidate));
    const matches = await visibleMatches(current.locator);

    if (matches.count === 0) {
      await context?.guided?.recordSelectorAttempt({
        action: "click",
        description,
        candidate: current.name,
        result: "not-visible",
        visibleCount: 0,
      });
      continue;
    }

    if (matches.count > 1) {
      await context?.guided?.recordSelectorAttempt({
        action: "click",
        description,
        candidate: current.name,
        result: "ambiguous",
        visibleCount: matches.count,
      });

      if (context?.strictSelectors) {
        throw new Error(`Selector ambiguo para "${description}": ${current.name} encontro ${matches.count} elementos visibles.`);
      }
    }

    await context?.guided?.recordSelectorAttempt({
      action: "click",
      description,
      candidate: current.name,
      result: "used",
      visibleCount: matches.count,
    });

    if (matches.first) {
      await matches.first.click();
      return;
    }
  }

  throw new Error(`No se encontro un elemento visible para: ${description}`);
}

export async function waitForAnyVisible(candidates: ElementCandidate[], description: string, timeoutMs = 10000): Promise<void> {
  if (candidates.length === 0) throw new Error(`No se definieron candidatos para: ${description}`);
  const normalized = candidates.map((item, index) => normalizeCandidate(item, index));
  const page = normalized[0]?.locator.page();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const current of normalized) {
      if ((await visibleMatches(current.locator)).count > 0) return;
    }
    await page?.waitForTimeout(75);
  }

  throw new Error(`No apareció un elemento visible para: ${description}`);
}

export async function fillFirstVisible(candidates: ElementCandidate[], value: string, description: string, context?: FlowContext): Promise<void> {
  for (const rawCandidate of candidates) {
    const current = normalizeCandidate(rawCandidate, candidates.indexOf(rawCandidate));
    const matches = await visibleMatches(current.locator);

    if (matches.count === 0) {
      await context?.guided?.recordSelectorAttempt({
        action: "fill",
        description,
        candidate: current.name,
        result: "not-visible",
        visibleCount: 0,
      });
      continue;
    }

    if (matches.count > 1) {
      await context?.guided?.recordSelectorAttempt({
        action: "fill",
        description,
        candidate: current.name,
        result: "ambiguous",
        visibleCount: matches.count,
      });

      if (context?.strictSelectors) {
        throw new Error(`Selector ambiguo para "${description}": ${current.name} encontro ${matches.count} elementos visibles.`);
      }
    }

    await context?.guided?.recordSelectorAttempt({
      action: "fill",
      description,
      candidate: current.name,
      result: "used",
      visibleCount: matches.count,
    });

    if (matches.first) {
      await matches.first.fill(value);
      return;
    }
  }

  throw new Error(`No se encontro un campo visible para: ${description}`);
}

export async function selectOptionLike(page: Page, label: string, value: string, context?: FlowContext): Promise<void> {
  const exact = page.getByLabel(label, { exact: false });
  const exactMatches = await visibleMatches(exact);
  if (exactMatches.count > 1 && context?.strictSelectors) {
    await context?.guided?.recordSelectorAttempt({
      action: "select",
      description: label,
      candidate: `label:${label}`,
      result: "ambiguous",
      visibleCount: exactMatches.count,
    });
    throw new Error(`Selector ambiguo para select "${label}": label:${label} encontro ${exactMatches.count} elementos visibles.`);
  }

  if (exactMatches.first) {
    const selected = await exactMatches.first.selectOption({ label: value })
      .then(() => true)
      .catch(async () => exactMatches.first?.selectOption(value).then(() => true).catch(() => false));

    if (selected) {
      await context?.guided?.recordSelectorAttempt({
        action: "select",
        description: label,
        candidate: `label:${label}`,
        result: "used",
      });
      return;
    }
  }

  const selectByNearbyText = page.locator("select").filter({ has: page.locator(`option:text("${value}")`) });
  const optionMatches = await visibleMatches(selectByNearbyText);
  if (optionMatches.count > 1 && context?.strictSelectors) {
    await context?.guided?.recordSelectorAttempt({
      action: "select",
      description: label,
      candidate: `select option:${value}`,
      result: "ambiguous",
      visibleCount: optionMatches.count,
    });
    throw new Error(`Selector ambiguo para select "${label}": option ${value} encontro ${optionMatches.count} selects visibles.`);
  }

  if (optionMatches.first) {
    await optionMatches.first.selectOption({ label: value }).catch(async () => {
      await optionMatches.first?.selectOption(value);
    });
    await context?.guided?.recordSelectorAttempt({
      action: "select",
      description: label,
      candidate: `select option:${value}`,
      result: "used",
    });
    return;
  }

  throw new Error(`No se pudo seleccionar "${value}" en "${label}"`);
}

export async function selectOptionContaining(locator: Locator, value: string): Promise<void> {
  const options = await readSelectOptions(locator);
  const selected = exactUniqueEnabledOption(options, value);
  await locator.selectOption({ index: selected.index });
  await assertSelectedOptionContaining(locator, value);
}

export async function assertSelectedOptionContaining(locator: Locator, value: string): Promise<string> {
  const options = await readSelectOptionsAfterPotentialNavigation(locator);
  const expected = exactUniqueEnabledOption(options, value);
  const selected = options.filter((option) => option.selected);
  if (selected.length !== 1 || selected[0]?.index !== expected.index) {
    throw new Error(`La opción exacta, única y habilitada "${value}" no quedó seleccionada de forma verificable.`);
  }
  return expected.text;
}

type VisibleTextSelectOption = {
  text: string;
  disabled: boolean;
  selected: boolean;
};

/**
 * Espera en modo de solo lectura una opción exacta, única, habilitada y ya
 * seleccionada por ARCA. No lee su value técnico ni dispara eventos change.
 */
export async function waitForUniqueSelectedEnabledOptionByVisibleText<const T extends string>(
  locator: Locator,
  expectedText: T,
  description: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let observedExpectedOption = false;

  while (Date.now() < deadline) {
    const options = await readVisibleTextSelectOptionsAfterPotentialNavigation(locator);
    const blankOptions = options.filter((option) => option.text === "");
    if (blankOptions.length > 0) {
      throw new Error(`${description}: ARCA mostró una opción de texto vacío; es una variante no aprendida y el flujo fue bloqueado.`);
    }
    const expectedOptions = options.filter((option) => option.text === expectedText);
    if (expectedOptions.length > 1) {
      throw new Error(`${description}: ARCA mostró ${expectedOptions.length} opciones "${expectedText}"; se exige exactamente una.`);
    }
    if (expectedOptions.length === 1) {
      observedExpectedOption = true;
      const expectedOption = expectedOptions[0] as VisibleTextSelectOption;
      if (expectedOption.disabled) {
        throw new Error(`${description}: la única opción "${expectedText}" está deshabilitada.`);
      }
      if (await locator.isDisabled().catch(() => true)) {
        throw new Error(`${description}: el selector de documento está deshabilitado.`);
      }
      const selectedOptions = options.filter((option) => option.selected);
      if (expectedOption.selected && selectedOptions.length > 1) {
        throw new Error(`${description}: ARCA mostró más de una opción seleccionada; el flujo fue bloqueado.`);
      }
      if (expectedOption.selected && selectedOptions.length === 1) {
        return expectedText;
      }
    }

    await locator.page().waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  if (!observedExpectedOption) {
    throw new Error(`${description}: ARCA no mostró una opción única "${expectedText}" dentro del tiempo esperado.`);
  }
  throw new Error(`${description}: la opción única "${expectedText}" no quedó preseleccionada por ARCA.`);
}

async function readVisibleTextSelectOptionsAfterPotentialNavigation(locator: Locator, timeoutMs = 3000): Promise<VisibleTextSelectOption[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readVisibleTextSelectOptions(locator);
    } catch (error) {
      if (Date.now() >= deadline || !isTransientNavigationReadError(error)) throw error;
      await locator.page().waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

async function readVisibleTextSelectOptions(locator: Locator): Promise<VisibleTextSelectOption[]> {
  return await locator.locator("option").evaluateAll((elements) => elements.map((element) => {
    const option = element as HTMLOptionElement;
    const parentDisabled = option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled;
    return {
      text: (option.textContent ?? "").trim(),
      disabled: option.disabled || parentDisabled,
      selected: option.selected,
    };
  }));
}

async function readSelectOptionsAfterPotentialNavigation(locator: Locator, timeoutMs = 3000): Promise<ExactSelectOption[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readSelectOptions(locator);
    } catch (error) {
      if (Date.now() >= deadline || !isTransientNavigationReadError(error)) throw error;
      await locator.page().waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

function isTransientNavigationReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached/i.test(message);
}

type ExactSelectOption = {
  index: number;
  text: string;
  value: string | null;
  disabled: boolean;
  selected: boolean;
};

async function readSelectOptions(locator: Locator): Promise<ExactSelectOption[]> {
  return await locator.locator("option").evaluateAll((elements) => elements.map((element, index) => {
    const option = element as HTMLOptionElement;
    const parentDisabled = option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled;
    return {
      index,
      text: (option.textContent ?? "").trim(),
      value: option.getAttribute("value"),
      disabled: option.disabled || parentDisabled,
      selected: option.selected,
    };
  }));
}

function exactUniqueEnabledOption(options: ExactSelectOption[], value: string): ExactSelectOption {
  const normalizedValue = normalizeForMatch(value);
  const candidates = options.filter((option) => optionMatchesExactValue(option, normalizedValue));
  if (candidates.length !== 1) {
    const found = candidates.length ? candidates.map((item) => item.text || item.value).join(" | ") : "ninguna";
    throw new Error("Se esperaba una opción exacta y única, además de habilitada, para \"" + value + "\". Coincidencias: " + found + ". Opciones: " + options.map((item) => item.text || item.value).join(" | "));
  }
  const candidate = candidates[0] as ExactSelectOption;
  if (candidate.disabled) {
    throw new Error(`La opción exacta y única para "${value}" está deshabilitada; se exige una opción habilitada.`);
  }
  return candidate;
}

function optionMatchesExactValue(option: Pick<ExactSelectOption, "text" | "value">, normalizedValue: string): boolean {
  const text = normalizeForMatch(option.text);
  const optionValue = normalizeForMatch(option.value ?? "");
  const numericPrefix = /^\d+$/.test(normalizedValue) && new RegExp("^" + normalizedValue + "(?:\\D|$)").test(text.replace(/\s+/g, ""));
  return text === normalizedValue || optionValue === normalizedValue || numericPrefix;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function waitForPageSettled(page: Page): Promise<void> {
  await waitForArcaDocumentReady(page);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await assertNoArcaAccessFailure(page);
}

export async function waitForArcaDocumentReady(page: Page, timeoutMs = 10000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await assertNoArcaAccessFailure(page);
}

export async function assertNoArcaAccessFailure(page: Page): Promise<void> {
  const failure = await detectArcaAccessFailure(page);
  if (failure === "expired") throw new Error("ARCA_SESSION_EXPIRED: la sesión de Clave Fiscal expiró. No reintentes el formulario; iniciá una autenticación nueva.");
  if (failure === "forbidden") throw new Error("ARCA_FORBIDDEN: ARCA rechazó el acceso a la pantalla. No reintentes automáticamente; verificá si la sesión expiró.");
}

export async function detectArcaAccessFailure(page: Page): Promise<"expired" | "forbidden" | undefined> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  return classifyArcaAccessFailure(url, title, body);
}

export function classifyArcaAccessFailure(url: string, title: string, body: string): "expired" | "forbidden" | undefined {
  if (/\/expiredSession(?:[/?#]|$)/i.test(url) || /TU SESI[ÓO]N HA EXPIRADO/i.test(body)) return "expired";
  if (/^403\s+Forbidden$/i.test(title.trim()) || (/^Forbidden\b/i.test(body.trim()) && /permission to access/i.test(body))) return "forbidden";
  return undefined;
}
