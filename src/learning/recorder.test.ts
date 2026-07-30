import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { BROWSER_RECORDER_SCRIPT, isLearningRecordingUrlAllowed, isLearningTopLevelSourceAllowed, isStableLearningPageUrl, sanitizeLearningUrl } from "./recorder.js";

test("el recorder se inyecta sin helpers privados de tsx", () => {
  assert.doesNotMatch(BROWSER_RECORDER_SCRIPT, /__name/);
  class Element {
    type = "";
    tagName = "DIV";
    id = "";
    innerText = "";
    textContent = "";
    getAttribute(): string { return ""; }
    closest(): null { return null; }
  }
  const events: Array<{ type?: string }> = [];
  const window: Record<string, unknown> = { __arcaLearnEvent: async (value: { type?: string }) => { events.push(value); } };
  vm.runInNewContext(BROWSER_RECORDER_SCRIPT, {
    window,
    document: { readyState: "complete", addEventListener: () => undefined },
    location: { href: "https://example.invalid/portal?private=redacted" },
    HTMLElement: Element,
    HTMLInputElement: Element,
  });
  assert.equal(window.__arcaLearningRecorderInstalled, true);
  assert.equal(events[0]?.type, "navigation");
});

test("las URLs de aprendizaje eliminan query, fragmento y jsessionid", () => {
  const parameterName = "jsession" + "id";
  const sanitized = sanitizeLearningUrl(`https://example.invalid/rcel/index.jsp;${parameterName}=SESSION_MARKER?q=query-marker#fragment-marker`);
  assert.equal(sanitized, "https://example.invalid/rcel/index.jsp");
  assert.doesNotMatch(sanitized, /SESSION_MARKER|query-marker|fragment-marker/);
});

test("el recorder solo admite los orígenes ARCA previstos", () => {
  assert.equal(isLearningRecordingUrlAllowed("https://portalcf.cloud.afip.gob.ar/portal/app/"), true);
  assert.equal(isLearningRecordingUrlAllowed("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp"), true);
  assert.equal(isLearningRecordingUrlAllowed("https://www.afip.gob.ar/ayuda"), false);
  assert.equal(isLearningRecordingUrlAllowed("https://example.invalid/"), false);
  assert.equal(isLearningRecordingUrlAllowed("https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/menu_ppal.jsp"), false);
  assert.equal(isLearningRecordingUrlAllowed("https://example.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp"), false);
  assert.equal(isLearningRecordingUrlAllowed("https://fe.afip.gob.ar:8443/rcel/jsp/menu_ppal.jsp"), false);
  const atSign = String.fromCharCode(64);
  assert.equal(isLearningRecordingUrlAllowed(`https://user${atSign}fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp`), false);
});

test("los eventos e inspecciones exigen frame principal y una URL superior estable", () => {
  const arca = "https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp";
  const external = "https://example.invalid/privado";
  assert.equal(isLearningTopLevelSourceAllowed(arca, arca, true), true);
  assert.equal(isLearningTopLevelSourceAllowed(arca, arca, false), false);
  assert.equal(isLearningTopLevelSourceAllowed(external, arca, true), false);
  assert.equal(isStableLearningPageUrl(arca, arca), true);
  assert.equal(isStableLearningPageUrl(arca, external), false);
});
