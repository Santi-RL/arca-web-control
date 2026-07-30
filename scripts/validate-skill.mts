import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type SkillValidationIssue = {
  file: string;
  category: string;
};

const PROHIBITED_AUXILIARY_FILES = new Set([
  "code_of_conduct.md",
  "contributing.md",
  "changelog.md",
  "installation_guide.md",
  "license",
  "quick_reference.md",
  "readme.md",
  "release_notes.md",
  "security.md",
]);

type SkillFrontmatter = {
  name?: string;
  description?: string;
};

export async function validateSkill(skillDirectory: string): Promise<SkillValidationIssue[]> {
  const skillRoot = path.resolve(skillDirectory);
  const issues: SkillValidationIssue[] = [];
  const skillMarkdownPath = path.join(skillRoot, "SKILL.md");
  let skillMarkdown = "";

  try {
    skillMarkdown = await fs.readFile(skillMarkdownPath, "utf8");
  } catch {
    return [{ file: "SKILL.md", category: "falta el archivo obligatorio" }];
  }

  const parsed = parseFrontmatter(skillMarkdown);
  issues.push(...parsed.issues);

  const folderName = path.basename(skillRoot);
  const name = parsed.frontmatter.name;
  if (name) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      issues.push({ file: "SKILL.md", category: "el nombre no cumple el formato de skill" });
    }
    if (name !== folderName) {
      issues.push({ file: "SKILL.md", category: "el nombre no coincide con la carpeta" });
    }
  }

  if (!parsed.body.trim()) {
    issues.push({ file: "SKILL.md", category: "el cuerpo de la skill está vacío" });
  }

  issues.push(...await validateOpenAiMetadata(skillRoot, name));
  issues.push(...await validateReferences(skillRoot, parsed.body));
  issues.push(...await findProhibitedAuxiliaryFiles(skillRoot));

  return deduplicateIssues(issues);
}

function parseFrontmatter(markdown: string): {
  frontmatter: SkillFrontmatter;
  body: string;
  issues: SkillValidationIssue[];
} {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const issues: SkillValidationIssue[] = [];
  const frontmatter: SkillFrontmatter = {};

  if (lines[0] !== "---") {
    return {
      frontmatter,
      body: normalized,
      issues: [{ file: "SKILL.md", category: "falta el frontmatter YAML inicial" }],
    };
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    return {
      frontmatter,
      body: "",
      issues: [{ file: "SKILL.md", category: "el frontmatter YAML no está cerrado" }],
    };
  }

  const seen = new Set<string>();
  for (const rawLine of lines.slice(1, closingIndex)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      issues.push({ file: "SKILL.md", category: "el frontmatter contiene una entrada YAML no admitida" });
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") {
      issues.push({ file: "SKILL.md", category: "el frontmatter solo admite name y description" });
      continue;
    }
    if (seen.has(key)) {
      issues.push({ file: "SKILL.md", category: `el frontmatter repite ${key}` });
      continue;
    }
    seen.add(key);

    const value = parseYamlScalar(line.slice(separator + 1).trim());
    if (!value) {
      issues.push({ file: "SKILL.md", category: `${key} no puede estar vacío` });
      continue;
    }
    frontmatter[key] = value;
  }

  for (const required of ["name", "description"] as const) {
    if (!seen.has(required)) {
      issues.push({ file: "SKILL.md", category: `falta ${required} en el frontmatter` });
    }
  }

  return {
    frontmatter,
    body: lines.slice(closingIndex + 1).join("\n"),
    issues,
  };
}

function parseYamlScalar(raw: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('"') || raw.endsWith('"')) {
    if (!(raw.startsWith('"') && raw.endsWith('"'))) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") || raw.endsWith("'")) {
    if (!(raw.startsWith("'") && raw.endsWith("'"))) return undefined;
    const parsed = raw.slice(1, -1).replace(/''/g, "'");
    return parsed.trim() ? parsed : undefined;
  }
  return raw.trim() || undefined;
}

async function validateOpenAiMetadata(skillRoot: string, skillName: string | undefined): Promise<SkillValidationIssue[]> {
  const relativeFile = "agents/openai.yaml";
  const metadataPath = path.join(skillRoot, "agents", "openai.yaml");
  let yaml: string;
  try {
    yaml = await fs.readFile(metadataPath, "utf8");
  } catch {
    return [{ file: relativeFile, category: "falta la metadata de interfaz" }];
  }

  const issues: SkillValidationIssue[] = [];
  const lines = yaml.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line.includes("\t"))) {
    issues.push({ file: relativeFile, category: "la metadata YAML contiene tabulaciones" });
  }

  const interfaceIndex = lines.findIndex((line) => line === "interface:");
  if (interfaceIndex < 0) {
    return [...issues, { file: relativeFile, category: "falta el bloque interface" }];
  }

  const values = new Map<string, string>();
  for (let index = interfaceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line && !line.startsWith(" ")) break;
    const match = /^  ([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    if (values.has(key)) {
      issues.push({ file: relativeFile, category: `interface repite ${key}` });
      continue;
    }
    const value = parseQuotedYamlString(rawValue);
    if (value === undefined) {
      issues.push({ file: relativeFile, category: `interface.${key} debe ser un string entre comillas` });
      continue;
    }
    values.set(key, value);
  }

  for (const required of ["display_name", "short_description", "default_prompt"] as const) {
    if (!values.get(required)?.trim()) {
      issues.push({ file: relativeFile, category: `falta interface.${required}` });
    }
  }

  const shortDescription = values.get("short_description");
  if (shortDescription && (Array.from(shortDescription).length < 25 || Array.from(shortDescription).length > 64)) {
    issues.push({ file: relativeFile, category: "interface.short_description debe tener entre 25 y 64 caracteres" });
  }

  const defaultPrompt = values.get("default_prompt");
  if (skillName && defaultPrompt && !defaultPrompt.includes(`$${skillName}`)) {
    issues.push({ file: relativeFile, category: "interface.default_prompt no menciona la skill con $nombre" });
  }

  return issues;
}

function parseQuotedYamlString(raw: string): string | undefined {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return undefined;
}

async function validateReferences(skillRoot: string, body: string): Promise<SkillValidationIssue[]> {
  const issues: SkillValidationIssue[] = [];
  const linkedReferences = new Set<string>();
  const referencePattern = /\breferences\/[A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]+\b/g;
  for (const match of body.matchAll(referencePattern)) {
    const relativeReference = (match[0] ?? "").replace(/\\/g, "/");
    if (!relativeReference) continue;
    linkedReferences.add(relativeReference);
  }

  for (const relativeReference of linkedReferences) {
    if (relativeReference.split("/").includes("..")) {
      issues.push({ file: "SKILL.md", category: "una referencia intenta salir de la carpeta de la skill" });
      continue;
    }
    const absoluteReference = path.resolve(skillRoot, ...relativeReference.split("/"));
    if (!isInside(skillRoot, absoluteReference)) {
      issues.push({ file: "SKILL.md", category: "una referencia intenta salir de la carpeta de la skill" });
      continue;
    }
    try {
      const stat = await fs.lstat(absoluteReference);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        issues.push({ file: relativeReference, category: "la referencia no es un archivo regular" });
      }
    } catch {
      issues.push({ file: relativeReference, category: "la referencia enlazada no existe" });
    }
  }

  const referencesRoot = path.join(skillRoot, "references");
  for (const relativeReference of await listFiles(referencesRoot, "references")) {
    if (!linkedReferences.has(relativeReference)) {
      issues.push({ file: relativeReference, category: "la referencia no está enlazada directamente desde SKILL.md" });
    }
  }

  return issues;
}

async function findProhibitedAuxiliaryFiles(skillRoot: string): Promise<SkillValidationIssue[]> {
  const issues: SkillValidationIssue[] = [];
  for (const relativeFile of await listFiles(skillRoot, "")) {
    if (PROHIBITED_AUXILIARY_FILES.has(path.basename(relativeFile).toLowerCase())) {
      issues.push({ file: relativeFile, category: "archivo auxiliar prohibido dentro de la skill" });
    }
  }
  return issues;
}

async function listFiles(directory: string, relativePrefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = [relativePrefix, entry.name].filter(Boolean).join("/");
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      files.push(relativePath);
    } else if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deduplicateIssues(issues: SkillValidationIssue[]): SkillValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.file}\u0000${issue.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeOutputPath(file: string): string {
  return file.replace(/[\u0000-\u001f\u007f]/g, "?");
}

async function runCli(): Promise<void> {
  const skillDirectory = process.argv[2] ?? path.join(".agents", "skills", "arca-web-control");
  const issues = await validateSkill(skillDirectory);
  if (issues.length > 0) {
    console.error(`SKILL_VALID=0`);
    for (const issue of issues) {
      console.error(`- ${sanitizeOutputPath(issue.file)}: ${issue.category}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("SKILL_VALID=1");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await runCli();
}
