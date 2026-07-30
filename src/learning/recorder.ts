import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Page } from "playwright";
import { z } from "zod";
import { waitForPageSettled } from "../arca/pageHelpers.js";
import { isCaptchaVisible } from "../arca/captcha.js";
import { isOfficialArcaPortalOriginUrl, isOfficialArcaRcelOriginUrl } from "../arca/officialUrls.js";
import { HybridMutation, isHybridMutationAllowed, normalizeLearningText } from "./commands.js";

const browserEventSchema = z.object({
  type: z.enum(["click", "change", "blocked_irreversible", "navigation"]),
  url: z.string().max(2048),
  element: z.object({
    tag: z.string().max(64),
    role: z.string().max(128),
    accessibleName: z.string().max(300),
    id: z.string().max(200),
    name: z.string().max(200),
    inputType: z.string().max(64),
  }).optional(),
});

export type LearningEvent = z.infer<typeof browserEventSchema> & { at: string; screenshot?: string };

export type LearningPageInspection = {
  inspectionId: string;
  url: string;
  title: string;
  actions: Array<{ name: string; tag: string }>;
  selects: Array<{ index: number; id: string | null; name: string | null; options: string[] }>;
  inputs: Array<{ index: number; type: string; id: string | null; name: string | null; valueLength: number }>;
};

export const BROWSER_RECORDER_SCRIPT = String.raw`(() => {
  const marker = "__arcaLearningRecorderInstalled";
  if (window[marker]) return;
  window[marker] = true;
  window.__arcaLearningDomRevision = 0;
  window.__arcaLearningDocumentNonce = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + String(Math.random());
  if (typeof MutationObserver !== "undefined" && document.documentElement) new MutationObserver(() => { window.__arcaLearningDomRevision += 1; }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  const irreversible = /\b(emitir|confirmar|presentar|pagar|enviar|guardar|eliminar|borrar|aceptar|autorizar|anular|cancelar|finalizar|procesar|liquidar)\b/i;
  const reversibleTerminalExit = /^(volver|men[uú] principal|salir|cerrar)$/i;
  const isTerminalPage = () => /\/rcel\/jsp\/genComResumenDatos\.do$/i.test(location.pathname.replace(/;jsessionid=[^/;?#]*/gi, ""));
  const controlText = (target) => target ? (target.getAttribute("aria-label") || (target instanceof HTMLInputElement ? target.value : target.textContent) || "") : "";
  const isReversibleTerminalExit = (target) => target instanceof HTMLElement && reversibleTerminalExit.test(controlText(target).replace(/\s+/g, " ").trim());
  const riskyFormControl = (form, submitter) => {
    if (submitter instanceof HTMLElement && irreversible.test(controlText(submitter))) return submitter;
    return Array.from(form.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button']")).find((control) => irreversible.test(controlText(control))) || null;
  };
  const send = (type, target) => {
    if (!(target instanceof HTMLElement)) return;
    const inputType = target instanceof HTMLInputElement ? target.type : "";
    if (inputType.toLowerCase() === "password") return;
    const accessibleName = (target.getAttribute("aria-label") || target.innerText || target.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const payload = {
      type,
      url: location.href,
      element: {
        tag: target.tagName.toLowerCase(),
        role: target.getAttribute("role") || "",
        accessibleName,
        id: target.id || "",
        name: target.getAttribute("name") || "",
        inputType,
      },
    };
    void window.__arcaLearnEvent(payload);
  };
  const sendNavigation = () => {
    void window.__arcaLearnEvent({ type: "navigation", url: location.href });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sendNavigation, { once: true });
  else sendNavigation();
  document.addEventListener("click", (event) => {
    const rawTarget = event.target;
    const target = rawTarget && typeof rawTarget.closest === "function" ? rawTarget.closest("button, a, input, [role='button']") : null;
    const text = controlText(target);
    if (target && (irreversible.test(text) || (isTerminalPage() && !isReversibleTerminalExit(target)))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send("blocked_irreversible", target);
      return;
    }
    send("click", target || event.target);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const risky = form ? riskyFormControl(form, event.submitter) : null;
    const terminalBlocked = Boolean(form && isTerminalPage() && !isReversibleTerminalExit(event.submitter));
    if (!risky && !terminalBlocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send("blocked_irreversible", risky || event.submitter || form);
  }, true);
  if (typeof HTMLFormElement !== "undefined") {
    const nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      const risky = riskyFormControl(this, null);
      if (risky || isTerminalPage()) { send("blocked_irreversible", risky || this); return; }
      return nativeSubmit.call(this);
    };
  }
  document.addEventListener("change", (event) => send("change", event.target), true);
})()`;

export class LearningRecorder {
  private sequence = 0;
  private readonly events: LearningEvent[] = [];
  private activePage: Page;
  private pending: Promise<void> = Promise.resolve();
  private lastInspection?: { id: string; fingerprint: string; page: Page; url: string };

  constructor(private readonly page: Page, private readonly directory: string) {
    this.activePage = page;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const context = this.page.context();
    await context.exposeBinding("__arcaLearnEvent", async (source, raw: unknown) => {
      const sourcePage = source.page;
      const sourceUrl = source.frame.url();
      if (!isLearningTopLevelSourceAllowed(sourcePage.url(), sourceUrl, source.frame === sourcePage.mainFrame())) return;
      await this.serialize(async () => {
        const stableUrl = sourcePage.url();
        if (!isLearningTopLevelSourceAllowed(stableUrl, source.frame.url(), source.frame === sourcePage.mainFrame())) return;
        const event = browserEventSchema.parse(raw);
        if (event.element?.inputType.toLowerCase() === "password") return;
        const screenshot = await this.capture(sourcePage, event.type);
        if (!isStableLearningPageUrl(stableUrl, sourcePage.url())) return;
        this.activePage = sourcePage;
        const complete = { ...event, url: sanitizeLearningUrl(stableUrl), at: new Date().toISOString(), screenshot };
        this.events.push(complete);
        await fs.appendFile(path.join(this.directory, "events.jsonl"), `${JSON.stringify(complete)}\n`, "utf8");
      });
    });
    await context.addInitScript(BROWSER_RECORDER_SCRIPT);
    await this.page.evaluate(BROWSER_RECORDER_SCRIPT);
  }

  async note(text: string, checkpoint?: string): Promise<void> {
    await this.serialize(async () => {
      const safe = text.trim().slice(0, 2000);
      const page = this.currentPage();
      const stableUrl = page.url();
      assertStableLearningPage(page, stableUrl, "guardar la nota");
      const screenshot = await this.capture(page, checkpoint ? `checkpoint-${checkpoint}` : "note");
      assertStableLearningPage(page, stableUrl, "guardar la nota");
      const event = { type: "navigation" as const, url: sanitizeLearningUrl(stableUrl), at: new Date().toISOString(), element: undefined, screenshot };
      this.events.push(event);
      await fs.appendFile(path.join(this.directory, "notes.jsonl"), `${JSON.stringify({ at: event.at, checkpoint, text: safe, screenshot: event.screenshot })}\n`, "utf8");
    });
  }

  async finish(metadata: { capability: string; intent: string; issuerKey: string }): Promise<string> {
    await this.pending;
    const candidatePath = path.join(this.directory, "candidate.json");
    const candidate = {
      version: 1,
      status: "candidate_only",
      ...metadata,
      finishedAt: new Date().toISOString(),
      eventCount: this.events.length,
      events: this.events,
      productionEnabled: false,
      hiddenAllowed: false,
    };
    await fs.writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    return candidatePath;
  }

  async settle(): Promise<void> {
    await this.pending;
  }

  async inspect(pageIndex?: number): Promise<LearningPageInspection> {
    await this.pending;
    const pages = this.page.context().pages().filter((candidate) => !candidate.isClosed() && isLearningRecordingUrlAllowed(candidate.url()));
    if (!pages.length) throw new Error("No hay ninguna pestaña ARCA permitida para inspeccionar.");
    if (pageIndex === undefined && pages.length !== 1) {
      const options = await Promise.all(pages.map(async (candidate, index) => `${index}: ${sanitizeLearningUrl(candidate.url())} (${await candidate.title().catch(() => "")})`));
      throw new Error(`Hay ${pages.length} pestañas abiertas. Ejecutá inspect <indice-pestaña> para elegir explícitamente una: ${options.join(" | ")}`);
    }
    const page = pages[pageIndex ?? 0];
    if (!page) throw new Error(`No existe una pestaña abierta con índice ${pageIndex}.`);
    const stableUrl = page.url();
    assertStableLearningPage(page, stableUrl, "iniciar la inspección");
    await page.evaluate(BROWSER_RECORDER_SCRIPT).catch(() => { throw new Error("No se pudo instrumentar la pestaña ARCA para una inspección verificable."); });
    assertStableLearningPage(page, stableUrl, "instrumentar la inspección");
    const inspectionId = randomUUID();
    const inspection = {
      inspectionId,
      url: sanitizeLearningUrl(stableUrl),
      title: await page.title().catch(() => ""),
      actions: await visibleActions(page),
      selects: await visibleSelects(page),
      inputs: await visibleInputs(page),
    };
    assertStableLearningPage(page, stableUrl, "leer la inspección");
    const fingerprint = await inspectionFingerprint(page, inspection, stableUrl);
    assertStableLearningPage(page, stableUrl, "cerrar la inspección");
    this.activePage = page;
    this.lastInspection = { id: inspectionId, fingerprint, page, url: stableUrl };
    return inspection;
  }

  async clickExact(inspectionId: string, text: string): Promise<void> {
    await this.serialize(async () => {
      const { page, verify } = await this.consumeInspection(inspectionId, "click");
      const candidates = await visibleActionLocators(page);
      const matching: number[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (!candidate) continue;
        const name = await inspectedActionName(candidate);
        if (normalize(name) === normalize(text)) matching.push(index);
      }
      if (matching.length !== 1) throw new Error(`Se esperaba una acción visible exacta para "${text}" y se encontraron ${matching.length}.`);
      const target = candidates[matching[0] as number];
      const handle = await target?.elementHandle();
      if (!handle) throw new Error("El control inspeccionado ya no existe. Reinspeccioná antes de actuar.");
      await verify();
      if (!await handle.evaluate((element) => element.isConnected).catch(() => false)) throw new Error("El control inspeccionado fue reemplazado. Reinspeccioná antes de actuar.");
      await handle.click();
      await page.waitForTimeout(300);
      await waitForPageSettled(this.currentPage());
    });
  }

  async selectExact(inspectionId: string, index: number, option: string): Promise<void> {
    await this.serialize(async () => {
      const { page, verify } = await this.consumeInspection(inspectionId, "select");
      const selects = await visibleSelectLocators(page);
      const select = selects[index];
      if (!select) throw new Error(`No existe un select visible con índice ${index}.`);
      const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({ text: (item.textContent ?? "").trim(), value: (item as HTMLOptionElement).value })));
      const matches = options.filter((item) => normalize(item.text) === normalize(option));
      if (matches.length !== 1) throw new Error(`La opción exacta "${option}" tuvo ${matches.length} coincidencias.`);
      const handle = await select.elementHandle();
      if (!handle) throw new Error("El select inspeccionado ya no existe. Reinspeccioná antes de actuar.");
      await verify();
      if (!await handle.evaluate((element) => element.isConnected).catch(() => false)) throw new Error("El select inspeccionado fue reemplazado. Reinspeccioná antes de actuar.");
      await handle.selectOption({ value: matches[0]?.value });
      await page.waitForTimeout(300);
      await waitForPageSettled(this.currentPage());
    });
  }

  async fillInput(inspectionId: string, index: number, value: string): Promise<void> {
    await this.serialize(async () => {
      const { page, verify } = await this.consumeInspection(inspectionId, "fill");
      const inputs = await visibleInputLocators(page);
      const input = inputs[index];
      if (!input) throw new Error(`No existe un input visible con índice ${index}.`);
      const type = (await input.getAttribute("type").catch(() => "")) ?? "";
      if (/password/i.test(type)) throw new Error("El modo aprendizaje no permite completar campos password.");
      const handle = await input.elementHandle();
      if (!handle) throw new Error("El campo inspeccionado ya no existe. Reinspeccioná antes de actuar.");
      await verify();
      if (!await handle.evaluate((element) => element.isConnected).catch(() => false)) throw new Error("El campo inspeccionado fue reemplazado. Reinspeccioná antes de actuar.");
      await handle.fill(value);
    });
  }

  async checkExact(inspectionId: string, text: string): Promise<void> {
    await this.serialize(async () => {
      const { page, verify } = await this.consumeInspection(inspectionId, "check");
      const matches = page.getByRole("checkbox", { name: text, exact: true });
      const visible = [];
      for (let index = 0; index < await matches.count(); index += 1) if (await matches.nth(index).isVisible().catch(() => false)) visible.push(matches.nth(index));
      if (visible.length !== 1) throw new Error(`Se esperaba un checkbox visible exacto para "${text}" y se encontraron ${visible.length}.`);
      const handle = await visible[0]?.elementHandle();
      if (!handle) throw new Error("El checkbox inspeccionado ya no existe. Reinspeccioná antes de actuar.");
      await verify();
      if (!await handle.evaluate((element) => element.isConnected).catch(() => false)) throw new Error("El checkbox inspeccionado fue reemplazado. Reinspeccioná antes de actuar.");
      await handle.check();
    });
  }

  async press(inspectionId: string, key: "Tab" | "Escape"): Promise<void> {
    await this.serialize(async () => {
      const { page, verify } = await this.consumeInspection(inspectionId, "press");
      if (key === "Tab") {
        const safeFocus = await page.evaluate(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return false;
          return active.type.toLowerCase() !== "password";
        });
        if (!safeFocus) throw new Error("Tab solo se permite cuando el foco está en un input visible que no sea password.");
      }
      await verify();
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      await waitForPageSettled(this.currentPage());
    });
  }

  private async consumeInspection(inspectionId: string, action: HybridMutation): Promise<{ page: Page; verify: () => Promise<void> }> {
    const expected = this.lastInspection;
    this.lastInspection = undefined;
    if (!expected || expected.id !== inspectionId) throw new Error("La inspección no existe, venció o ya fue utilizada. Ejecutá inspect nuevamente.");
    const page = expected.page;
    const verify = async () => {
      if (page.isClosed()) throw new Error("La pestaña inspeccionada se cerró. Reinspeccioná antes de actuar.");
      assertStableLearningPage(page, expected.url, "consumir la inspección");
      if (await isCaptchaVisible(page)) throw new Error("ARCA está solicitando captcha. La inspección fue invalidada y se requiere intervención humana.");
      assertHybridMutationPage(page, action);
      const current = {
        inspectionId,
        url: sanitizeLearningUrl(page.url()),
        title: await page.title().catch(() => ""),
        actions: await visibleActions(page),
        selects: await visibleSelects(page),
        inputs: await visibleInputs(page),
      };
      if (await inspectionFingerprint(page, current, expected.url) !== expected.fingerprint) {
        throw new Error("La página o sus controles cambiaron desde inspect. Reinspeccioná antes de actuar.");
      }
    };
    await verify();
    return { page, verify };
  }

  get count(): number { return this.events.length; }
  get url(): string { return sanitizeLearningUrl(this.currentPage().url()); }

  private currentPage(): Page {
    if (!this.activePage.isClosed() && isLearningRecordingUrlAllowed(this.activePage.url())) return this.activePage;
    const allowed = this.page.context().pages().filter((candidate) => !candidate.isClosed() && isLearningRecordingUrlAllowed(candidate.url())).at(-1);
    if (!allowed) throw new Error("No hay una pestaña ARCA permitida disponible para el aprendizaje.");
    return allowed;
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action, action);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async capture(page: Page, label: string): Promise<string | undefined> {
    if (page.isClosed() || !isLearningRecordingUrlAllowed(page.url())) return undefined;
    this.sequence += 1;
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
    const filePath = path.join(this.directory, `${String(this.sequence).padStart(4, "0")}-${safe}.png`);
    const token = await page.evaluate(() => {
      const changed: Array<{ element: HTMLElement; filter: string }> = [];
      for (const element of document.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable=true]")) { changed.push({ element, filter: element.style.filter }); element.style.filter = "blur(12px)"; }
      (window as unknown as { __arcaRedactedControls?: typeof changed }).__arcaRedactedControls = changed;
      return changed.length;
    }).catch(() => 0);
    if (!isLearningRecordingUrlAllowed(page.url())) {
      if (token) await restoreRedactedControls(page);
      return undefined;
    }
    const capturedUrl = page.url();
    const screenshot = await page.screenshot({ fullPage: true, animations: "disabled", mask: [page.locator("iframe")] }).catch(() => undefined);
    if (token) await restoreRedactedControls(page);
    if (!screenshot || page.url() !== capturedUrl || !isLearningRecordingUrlAllowed(page.url())) return undefined;
    await fs.writeFile(filePath, screenshot, { flag: "wx" });
    return filePath;
  }
}

async function restoreRedactedControls(page: Page): Promise<void> {
  await page.evaluate(() => { const scope = window as unknown as { __arcaRedactedControls?: Array<{ element: HTMLElement; filter: string }> }; for (const item of scope.__arcaRedactedControls ?? []) item.element.style.filter = item.filter; delete scope.__arcaRedactedControls; }).catch(() => undefined);
}

async function visibleActions(page: Page): Promise<Array<{ name: string; tag: string }>> {
  const locators = await visibleActionLocators(page);
  const result: Array<{ name: string; tag: string }> = [];
  for (const item of locators) {
    const name = await inspectedActionName(item);
    if (name) result.push({ name, tag: await item.evaluate((element) => element.tagName.toLowerCase()) });
  }
  return result;
}

async function visibleActionLocators(page: Page): Promise<Array<ReturnType<Page["locator"]>>> {
  const locator = page.locator("button, a, input[type='button'], input[type='submit'], [role='button']");
  const result: Array<ReturnType<Page["locator"]>> = [];
  for (let index = 0; index < await locator.count() && result.length < 100; index += 1) {
    const item = locator.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    result.push(item);
  }
  return result;
}

async function accessibleActionName(locator: ReturnType<Page["locator"]>): Promise<string> {
  return await locator.evaluate((element) => {
    const renderedInputLabel = element instanceof HTMLInputElement ? element.value : "";
    return (element.getAttribute("aria-label") || element.getAttribute("title") || renderedInputLabel || element.textContent || "").replace(/\s+/g, " ").trim();
  }).catch(() => "");
}

async function inspectedActionName(locator: ReturnType<Page["locator"]>): Promise<string> {
  return (await accessibleActionName(locator)).slice(0, 300);
}

async function visibleSelectLocators(page: Page): Promise<Array<ReturnType<Page["locator"]>>> {
  const locator = page.locator("select");
  const result: Array<ReturnType<Page["locator"]>> = [];
  for (let index = 0; index < Math.min(await locator.count(), 100); index += 1) if (await locator.nth(index).isVisible().catch(() => false)) result.push(locator.nth(index));
  return result;
}

async function visibleSelects(page: Page): Promise<LearningPageInspection["selects"]> {
  const selects = await visibleSelectLocators(page);
  return await Promise.all(selects.map(async (select, index) => ({
    index,
    id: await select.getAttribute("id"),
    name: await select.getAttribute("name"),
    options: (await select.locator("option").allTextContents()).map((item) => item.trim()).filter(Boolean).slice(0, 100),
  })));
}

async function visibleInputLocators(page: Page): Promise<Array<ReturnType<Page["locator"]>>> {
  const locator = page.locator("input, textarea");
  const result: Array<ReturnType<Page["locator"]>> = [];
  for (let index = 0; index < Math.min(await locator.count(), 100); index += 1) {
    const item = locator.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    const type = (await item.getAttribute("type").catch(() => "")) ?? "";
    if (/^(hidden|button|submit|reset|checkbox|radio|password)$/i.test(type)) continue;
    result.push(item);
  }
  return result;
}

async function visibleInputs(page: Page): Promise<LearningPageInspection["inputs"]> {
  const inputs = await visibleInputLocators(page);
  return await Promise.all(inputs.map(async (input, index) => ({
    index,
    type: (await input.getAttribute("type")) ?? "text",
    id: await input.getAttribute("id"),
    name: await input.getAttribute("name"),
    valueLength: (await input.inputValue().catch(() => "")).length,
  })));
}

function normalize(value: string): string {
  return normalizeLearningText(value);
}

function assertHybridMutationPage(page: Page, action: HybridMutation): void {
  if (!isHybridMutationAllowed(page.url(), action)) {
    throw new Error(`La acción híbrida ${action} no está permitida en esta pantalla. El usuario debe intervenir manualmente y registrar el flujo.`);
  }
}

async function inspectionFingerprint(page: Page, inspection: LearningPageInspection, expectedUrl: string): Promise<string> {
  assertStableLearningPage(page, expectedUrl, "calcular la huella de inspección");
  const documentState = await page.evaluate((trustedUrl) => {
    if (location.href !== trustedUrl) throw new Error("learning-page-changed");
    const privateFormState = Array.from(document.querySelectorAll("input:not([type='password']), textarea, select")).map((element) => {
      if (element instanceof HTMLSelectElement) return { tag: "select", id: element.id, name: element.name, value: element.value, selectedIndex: element.selectedIndex };
      const control = element as HTMLInputElement | HTMLTextAreaElement;
      return { tag: element.tagName.toLowerCase(), id: control.id, name: control.getAttribute("name") ?? "", type: control instanceof HTMLInputElement ? control.type : "textarea", value: control.value, checked: control instanceof HTMLInputElement ? control.checked : undefined };
    });
    return {
      domRevision: (window as unknown as { __arcaLearningDomRevision?: unknown }).__arcaLearningDomRevision,
      documentNonce: (window as unknown as { __arcaLearningDocumentNonce?: unknown }).__arcaLearningDocumentNonce,
      privateFormState,
    };
  }, expectedUrl).catch(() => undefined);
  assertStableLearningPage(page, expectedUrl, "calcular la huella de inspección");
  if (!documentState || !Number.isInteger(documentState.domRevision) || (documentState.domRevision as number) < 0 || typeof documentState.documentNonce !== "string" || !documentState.documentNonce) {
    throw new Error("La pestaña ARCA no tiene una instrumentación verificable. Reinspeccioná antes de actuar.");
  }
  const domRevision = documentState.domRevision as number;
  const documentNonce = documentState.documentNonce;
  const stable = {
    url: expectedUrl,
    title: inspection.title,
    domRevision,
    documentNonce,
    actions: inspection.actions,
    selects: inspection.selects,
    inputs: inspection.inputs.map(({ valueLength: _valueLength, ...input }) => input),
    privateFormStateDigest: createHash("sha256").update(JSON.stringify(documentState.privateFormState)).digest("hex"),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function sanitizeLearningUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/;jsessionid=[^/;?#]*/gi, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return (value.split("?")[0] ?? value).replace(/;jsessionid=[^/;?#]*/gi, "");
  }
}

export function isLearningRecordingUrlAllowed(value: string): boolean {
  return isOfficialArcaPortalOriginUrl(value) || isOfficialArcaRcelOriginUrl(value);
}

export function isLearningTopLevelSourceAllowed(pageUrl: string, frameUrl: string, isMainFrame: boolean): boolean {
  return isMainFrame && pageUrl === frameUrl && isLearningRecordingUrlAllowed(pageUrl);
}

export function isStableLearningPageUrl(expectedUrl: string, currentUrl: string): boolean {
  return expectedUrl === currentUrl && isLearningRecordingUrlAllowed(expectedUrl);
}

function assertStableLearningPage(page: Page, expectedUrl: string, action: string): void {
  if (page.isClosed() || !isStableLearningPageUrl(expectedUrl, page.url())) {
    throw new Error(`La pestaña cambió de URL u origen durante ${action}. La inspección fue descartada.`);
  }
}
