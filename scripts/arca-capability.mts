import fs from "node:fs/promises";
import path from "node:path";
import { isMaturity, loadCapabilityRegistry, parseCapabilityManifest } from "../src/capabilities/registry.js";
import { renderCapabilities, renderSkillCapabilities, renderSkillCommands, writeGeneratedCapabilities } from "../src/capabilities/generate.js";
import { writeJsonAtomic } from "../src/io/atomicJson.js";

const [operation, ...args] = process.argv.slice(2);
const manifests = await loadCapabilityRegistry();

if (operation === "sync") {
  await writeGeneratedCapabilities(manifests);
  console.log(`CAPABILITIES_SYNCED=${manifests.length}`);
} else if (operation === "check") {
  await checkGenerated(manifests);
  console.log(`CAPABILITIES_OK=${manifests.length}`);
} else if (operation === "promote") {
  const capabilityId = valueAfter(args, "--capability");
  const maturity = valueAfter(args, "--maturity");
  const humanApproved = args.includes("--human-approved");
  const enableHidden = args.includes("--enable-hidden");
  if (!capabilityId || !maturity || !isMaturity(maturity)) throw new Error("Uso: promote --capability <slug> --maturity <nivel> [--human-approved] [--enable-hidden]");
  const manifest = manifests.find((item) => item.id === capabilityId);
  if (!manifest) throw new Error(`Capacidad desconocida: ${capabilityId}.`);
  if ((manifest.irreversibleAction || maturity === "fast_path" || enableHidden) && !humanApproved) {
    throw new Error("La promoción irreversible, fast_path o modo oculto requiere --human-approved después de una validación humana real.");
  }
  if (enableHidden && maturity !== "fast_path") throw new Error("--enable-hidden solo se admite al promover a fast_path.");
  if (manifest.testEvidence.length === 0 || manifest.realEvidence.length === 0 || !manifest.lastValidatedVisible || !manifest.lastValidatedAt) {
    throw new Error("Faltan pruebas, evidencia real visible o validación humana para promover.");
  }
  const next = parseCapabilityManifest({ ...manifest, maturity, hiddenAllowed: enableHidden });
  await writeJsonAtomic(path.resolve("config", "capabilities", `${capabilityId}.json`), next);
  console.log(`CAPABILITY_PROMOTED=${capabilityId}:${maturity}`);
} else {
  throw new Error("Uso: arca-capability.mts sync|check|promote");
}

async function checkGenerated(current: Awaited<ReturnType<typeof loadCapabilityRegistry>>): Promise<void> {
  const references = path.resolve(".agents", "skills", "arca-web-control", "references");
  const actualDocs = await fs.readFile(path.resolve("docs", "capacidades.md"), "utf8").catch(() => "");
  const actualCapabilities = await fs.readFile(path.join(references, "capabilities.md"), "utf8").catch(() => "");
  const actualCommands = await fs.readFile(path.join(references, "commands.md"), "utf8").catch(() => "");
  if (actualDocs !== renderCapabilities(current) || actualCapabilities !== renderSkillCapabilities(current) || actualCommands !== renderSkillCommands(current)) {
    throw new Error("Las referencias generadas están desactualizadas. Ejecutá arca:capability:sync.");
  }
  const roadmap = await fs.readFile(path.resolve("docs", "estado-y-roadmap.md"), "utf8");
  for (const manifest of current) {
    if (!roadmap.includes(manifest.id)) throw new Error(`El roadmap no menciona ${manifest.id}.`);
    for (const evidence of manifest.testEvidence) {
      await assertRepositoryEvidence(evidence, false);
    }
    for (const evidence of manifest.realEvidence) {
      await assertRepositoryEvidence(evidence, true);
    }
  }
}

async function assertRepositoryEvidence(reference: string, requireHeading: boolean): Promise<void> {
  const [relativeFile, heading, ...extra] = reference.split("#");
  if (!relativeFile || extra.length > 0 || path.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/u).includes("..")) {
    throw new Error("Una referencia de evidencia no usa una ruta relativa válida del repositorio.");
  }
  const absoluteFile = path.resolve(relativeFile);
  const relativeToRoot = path.relative(process.cwd(), absoluteFile);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Una referencia de evidencia escapa del repositorio.");
  }
  const contents = await fs.readFile(absoluteFile, "utf8").catch(() => undefined);
  if (contents === undefined) throw new Error(`Falta evidencia: ${relativeFile}.`);
  if (!requireHeading) return;
  if (!heading) throw new Error(`La evidencia real ${relativeFile} debe señalar un encabezado concreto.`);
  const headings = contents
    .split(/\r?\n/u)
    .filter((line) => /^#{1,6}\s+/u.test(line))
    .map((line) => markdownHeadingSlug(line.replace(/^#{1,6}\s+/u, "")));
  if (!headings.includes(heading)) {
    throw new Error(`La evidencia real ${relativeFile} no contiene el encabezado declarado.`);
  }
}

function markdownHeadingSlug(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
