import fs from "node:fs/promises";
import path from "node:path";
import { Page } from "playwright";
import { askText } from "../io/prompt.js";
import { CheckpointDetails, SelectorAttempt } from "./flowContext.js";
import { getRuntimePaths } from "../config/runtimePaths.js";
import { sanitizeArcaUrlForOutput } from "./officialUrls.js";

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
}

export class GuidedSession {
  private step = 0;

  private constructor(private readonly artifactDir: string) {}

  static async create(baseDir = path.join(getRuntimePaths().root, "guided")): Promise<GuidedSession> {
    const artifactDir = path.join(baseDir, timestampForPath());
    await fs.mkdir(artifactDir, { recursive: true });
    console.log(`Modo guiado activo. Artefactos: ${artifactDir}`);
    console.log("Comandos en cada pausa: Enter/CONTINUAR para avanzar, DETENER para cancelar.");
    return new GuidedSession(artifactDir);
  }

  async checkpoint(page: Page, details: CheckpointDetails): Promise<void> {
    this.step += 1;
    const stepId = `${String(this.step).padStart(2, "0")}-${slugify(details.title)}`;
    const screenshotPath = path.join(this.artifactDir, `${stepId}.png`);
    const metadataPath = path.join(this.artifactDir, `${stepId}.json`);

    const title = await page.title().catch(() => "");
    const url = sanitizeArcaUrlForOutput(page.url());
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
    await fs.writeFile(metadataPath, JSON.stringify({
      step: this.step,
      title: details.title,
      expected: details.expected,
      nextAction: details.nextAction,
      pageTitle: title,
      url,
      screenshotPath,
      createdAt: new Date().toISOString(),
    }, null, 2));

    console.log("");
    console.log(`Paso guiado ${this.step}: ${details.title}`);
    console.log(`URL: ${url}`);
    if (title) {
      console.log(`Titulo: ${title}`);
    }
    console.log(`Validar visualmente: ${details.expected}`);
    if (details.nextAction) {
      console.log(`Siguiente accion: ${details.nextAction}`);
    }
    console.log(`Screenshot: ${screenshotPath}`);

    const answer = await askText("Revisa el navegador. Enter/CONTINUAR avanza; DETENER cancela");
    if (answer.trim().toUpperCase() === "DETENER") {
      throw new Error(`Flujo detenido manualmente en paso guiado ${this.step}: ${details.title}`);
    }
  }

  async recordSelectorAttempt(attempt: SelectorAttempt): Promise<void> {
    const line = JSON.stringify({
      ...attempt,
      createdAt: new Date().toISOString(),
    });
    await fs.appendFile(path.join(this.artifactDir, "selector-audit.jsonl"), `${line}\n`);
  }
}
