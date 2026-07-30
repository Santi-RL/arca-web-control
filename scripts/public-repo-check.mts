import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PublicRepositoryIssue = {
  file: string;
  line?: number;
  category: string;
};

const ALLOWED_SYNTHETIC_CUITS = new Set(["20000000001", "20000000002", "27000000006"]);
const ALLOWED_SYNTHETIC_CAES = new Set(["99999999999999"]);
const ALLOWED_SYNTHETIC_VOUCHERS = new Set(["00001-00000042"]);

const BLOCKED_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".avif",
  ".bak",
  ".bmp",
  ".cer",
  ".crt",
  ".csr",
  ".csv",
  ".db",
  ".docx",
  ".dmp",
  ".gif",
  ".gz",
  ".har",
  ".ico",
  ".jpeg",
  ".jpg",
  ".jsonl",
  ".key",
  ".log",
  ".mhtml",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".p12",
  ".pcap",
  ".pdf",
  ".pem",
  ".pfx",
  ".png",
  ".pptx",
  ".rar",
  ".sqlite",
  ".sqlite3",
  ".svg",
  ".tar",
  ".tif",
  ".tiff",
  ".trace",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

const BLOCKED_ROOT_PREFIXES = [
  ".playwright/",
  ".playwright-mcp/",
  "artifacts/",
  "downloads/",
  "jobs/private/",
  "learning/",
  "ledger/",
  "logs/",
  "playwright-report/",
  "private-import/",
  "profiles/",
  "sessions/",
  "test-results/",
];

const BLOCKED_SECRET_FILE_NAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  "current.json",
  "current.lock",
]);

export async function validatePublicRepository(repositoryRoot: string): Promise<PublicRepositoryIssue[]> {
  const root = path.resolve(repositoryRoot);
  const files = listGitCandidateFiles(root);
  const issues: PublicRepositoryIssue[] = [];

  for (const relativeFile of files) {
    if (isExcludedDirectory(relativeFile)) continue;
    const fileNameIssues = scanPublicFileName(relativeFile);
    const issueFile = fileNameIssues.length > 0 ? "[ruta-de-archivo-redactada]" : relativeFile;
    issues.push(...checkPublicPath(relativeFile).map((issue) => ({ ...issue, file: issueFile })));
    issues.push(...fileNameIssues);

    const absoluteFile = path.resolve(root, ...relativeFile.split("/"));
    if (!isInside(root, absoluteFile)) {
      issues.push({ file: issueFile, category: "ruta fuera del repositorio" });
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(absoluteFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      issues.push({ file: issueFile, category: "no se pudo inspeccionar el archivo" });
      continue;
    }

    if (stat.isSymbolicLink()) {
      issues.push({ file: issueFile, category: "enlace simbólico no permitido" });
      continue;
    }
    if (!stat.isFile()) continue;

    const realFile = await fs.realpath(absoluteFile).catch(() => undefined);
    if (!realFile || !isInside(root, realFile)) {
      issues.push({ file: issueFile, category: "el archivo resuelve fuera del repositorio" });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absoluteFile);
    } catch {
      issues.push({ file: issueFile, category: "no se pudo leer el archivo" });
      continue;
    }

    if (buffer.includes(0)) {
      issues.push({ file: issueFile, category: "archivo binario no permitido" });
      continue;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      issues.push({ file: issueFile, category: "archivo no textual o UTF-8 inválido" });
      continue;
    }
    issues.push(...scanPublicText(text, issueFile));
  }

  issues.push(...scanReachableGitHistory(root));

  return redactRepositoryIssuePaths(deduplicateIssues(issues));
}

export function checkPublicPath(relativeFile: string): PublicRepositoryIssue[] {
  const normalized = relativeFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const baseName = path.posix.basename(lower);
  const issues: PublicRepositoryIssue[] = [];

  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    issues.push({ file: normalized, category: "ruta de repositorio inválida" });
  }

  if (lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example" && lower !== ".env.local.example")) {
    issues.push({ file: normalized, category: "archivo de entorno privado" });
  }
  if (baseName.endsWith(".secret.json") || BLOCKED_SECRET_FILE_NAMES.has(baseName)) {
    issues.push({ file: normalized, category: "archivo de secretos o estado privado" });
  }
  if (/^storagestate.*\.json$/i.test(baseName) || /^storage-state.*\.json$/i.test(baseName)) {
    issues.push({ file: normalized, category: "estado autenticado de navegador" });
  }
  if (BLOCKED_EXTENSIONS.has(path.posix.extname(lower))) {
    issues.push({ file: normalized, category: "formato privado o binario no permitido" });
  }
  if (BLOCKED_ROOT_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix))) {
    issues.push({ file: normalized, category: "ruta reservada para datos privados" });
  }
  if (lower.startsWith("jobs/") && !baseName.endsWith(".example.json")) {
    issues.push({ file: normalized, category: "job no anonimizado o fuera del formato de ejemplo" });
  }

  return issues;
}

export function scanPublicText(text: string, relativeFile: string): PublicRepositoryIssue[] {
  const issues: PublicRepositoryIssue[] = [];
  const lineStarts = buildLineStarts(text);
  const addAt = (index: number, category: string): void => {
    issues.push({ file: relativeFile, line: lineNumberAt(lineStarts, index), category });
  };

  const privateKeyPattern = new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""), "g");
  for (const match of text.matchAll(privateKeyPattern)) addAt(match.index ?? 0, "clave privada incrustada");

  const knownSecretPatterns: Array<{ pattern: RegExp; category: string }> = [
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, category: "credencial de proveedor cloud" },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, category: "token de GitHub" },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, category: "token de GitHub" },
    { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, category: "token de GitLab" },
    { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, category: "clave de API" },
    { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, category: "token de Slack" },
    { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, category: "token JWT incrustado" },
    { pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s/]+/g, category: "credencial incrustada en URL" },
    { pattern: /\b(?:password|passwd|secret|token|api[_-]?key|clave(?:_?fiscal)?)\s*[:=]\s*["'`][^"'`\r\n]{12,}["'`]/gi, category: "secreto literal asignado" },
  ];
  for (const { pattern, category } of knownSecretPatterns) {
    for (const match of text.matchAll(pattern)) addAt(match.index ?? 0, category);
  }

  const arcaFiscalSecretAssignment = /^[ \t]*(?:export[ \t]+)?ARCA_CLIENT_[A-Z0-9_]+_CLAVE[ \t]*=[ \t]*([^#\r\n]*)$/gim;
  for (const match of text.matchAll(arcaFiscalSecretAssignment)) {
    const assignedValue = (match[1] ?? "").trim();
    if (assignedValue && assignedValue !== "\"\"" && assignedValue !== "''") {
      addAt(match.index ?? 0, "clave fiscal asignada en configuración");
    }
  }

  const emailPattern = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  for (const match of text.matchAll(emailPattern)) {
    const address = (match[0] ?? "").toLowerCase();
    const domain = (match[1] ?? "").toLowerCase();
    const allowed = address === "noreply@github.com"
      || domain === "example.com"
      || domain === "example.org"
      || domain === "example.invalid"
      || domain.endsWith(".test")
      || domain === "users.noreply.github.com";
    if (!allowed) addAt(match.index ?? 0, "correo electrónico personal no permitido");
  }

  const windowsUserPath = /\b[A-Za-z]:[\\/]Users[\\/](?!<(?:usuario|user)>)[^\\/\s"'`<>]+[\\/]/gi;
  for (const match of text.matchAll(windowsUserPath)) addAt(match.index ?? 0, "ruta absoluta de perfil de usuario");
  const unixUserPath = /(?:^|[\s"'`(])\/(?:Users|home)\/(?!<(?:usuario|user)>)[A-Za-z0-9._-]+\//gim;
  for (const match of text.matchAll(unixUserPath)) addAt(match.index ?? 0, "ruta absoluta de perfil de usuario");

  for (const match of text.matchAll(/\b\d{11}\b/g)) {
    const value = match[0] ?? "";
    if (!ALLOWED_SYNTHETIC_CUITS.has(value)) addAt(match.index ?? 0, "identificador fiscal de 11 dígitos no permitido");
  }
  for (const match of text.matchAll(/\b\d{2}-\d{8}-\d\b/g)) {
    const normalized = (match[0] ?? "").replace(/-/g, "");
    if (!ALLOWED_SYNTHETIC_CUITS.has(normalized)) addAt(match.index ?? 0, "identificador fiscal con guiones no permitido");
  }
  for (const match of text.matchAll(/\b\d{14}\b/g)) {
    const value = match[0] ?? "";
    if (!ALLOWED_SYNTHETIC_CAES.has(value)) addAt(match.index ?? 0, "identificador fiscal de 14 dígitos no permitido");
  }
  for (const match of text.matchAll(/\b\d{22}\b/g)) addAt(match.index ?? 0, "identificador bancario de 22 dígitos no permitido");
  for (const match of text.matchAll(/\b\d{5}-\d{8}\b/g)) {
    if (!ALLOWED_SYNTHETIC_VOUCHERS.has(match[0] ?? "")) addAt(match.index ?? 0, "número de comprobante no permitido");
  }
  for (const match of text.matchAll(/\+54[\s()-]*\d(?:[\s()-]*\d){7,12}/g)) addAt(match.index ?? 0, "teléfono personal no permitido");

  return deduplicateIssues(issues);
}

export function scanPublicFileName(relativeFile: string): PublicRepositoryIssue[] {
  return scanPublicText(relativeFile, "[ruta-de-archivo-redactada]").map((issue) => ({
    file: "[ruta-de-archivo-redactada]",
    category: `${issue.category} en nombre o ruta de archivo`,
  }));
}

export function isAllowedGitNoreplyEmail(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "noreply@github.com" || /^[^\s@]+@users\.noreply\.github\.com$/i.test(normalized);
}

function scanReachableGitHistory(repositoryRoot: string): PublicRepositoryIssue[] {
  const commitsResult = spawnSync("git", ["rev-list", "--all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (commitsResult.status !== 0) {
    throw new Error("No se pudo enumerar el historial alcanzable de Git.");
  }

  const commits = commitsResult.stdout.split(/\r?\n/).filter(Boolean);
  const blobs = new Map<string, string>();
  for (const commit of commits) {
    const treeResult = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (treeResult.status !== 0 || !Buffer.isBuffer(treeResult.stdout)) {
      throw new Error("No se pudo inspeccionar el árbol de un commit alcanzable.");
    }
    for (const entry of treeResult.stdout.toString("utf8").split("\u0000").filter(Boolean)) {
      const match = entry.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/i);
      if (!match) continue;
      const objectId = match[1] as string;
      const relativeFile = (match[2] as string).replace(/\\/g, "/");
      blobs.set(`${objectId}\u0000${relativeFile}`, relativeFile);
    }
  }

  const issues: PublicRepositoryIssue[] = [];
  const commitMetadataFile = "@history/[metadatos-de-commit]";
  for (const commit of commits) {
    const metadataResult = spawnSync("git", ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", commit], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (metadataResult.status !== 0) {
      issues.push({ file: commitMetadataFile, category: "no se pudieron inspeccionar metadatos de un commit" });
      continue;
    }
    const [authorName = "", authorEmail = "", committerName = "", committerEmail = "", ...messageParts] = metadataResult.stdout.split("\u0000");
    if (!isAllowedGitNoreplyEmail(authorEmail) || !isAllowedGitNoreplyEmail(committerEmail)) {
      issues.push({ file: commitMetadataFile, category: "identidad Git sin correo noreply" });
    }
    issues.push(...scanPublicText([authorName, authorEmail, committerName, committerEmail, messageParts.join("\u0000")].join("\n"), commitMetadataFile));
  }

  const tagsResult = spawnSync("git", ["for-each-ref", "--format=%(taggeremail)%00%(contents)%00", "refs/tags"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (tagsResult.status !== 0) {
    issues.push({ file: "@history/[metadatos-de-tag]", category: "no se pudieron inspeccionar tags" });
  } else if (tagsResult.stdout) {
    const tagFields = tagsResult.stdout.split("\u0000");
    for (let index = 0; index + 1 < tagFields.length; index += 2) {
      const taggerEmail = tagFields[index]?.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1];
      if (taggerEmail && !isAllowedGitNoreplyEmail(taggerEmail)) {
        issues.push({ file: "@history/[metadatos-de-tag]", category: "identidad de tag sin correo noreply" });
      }
    }
    issues.push(...scanPublicText(tagsResult.stdout, "@history/[metadatos-de-tag]"));
  }

  const refsResult = spawnSync("git", ["for-each-ref", "--format=%(refname)"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (refsResult.status !== 0) {
    issues.push({ file: "@history/[referencias-git]", category: "no se pudieron inspeccionar referencias Git" });
  } else {
    issues.push(...scanPublicText(refsResult.stdout, "@history/[referencias-git]"));
  }

  for (const [key, relativeFile] of blobs) {
    const objectId = key.slice(0, key.indexOf("\u0000"));
    const fileNameIssues = scanPublicFileName(relativeFile);
    const historyFile = fileNameIssues.length > 0 ? "@history/[ruta-de-archivo-redactada]" : `@history/${relativeFile}`;
    issues.push(...checkPublicPath(relativeFile).map((issue) => ({ ...issue, file: historyFile })));
    issues.push(...fileNameIssues.map((issue) => ({ ...issue, file: "@history/[ruta-de-archivo-redactada]" })));

    const blobResult = spawnSync("git", ["cat-file", "blob", objectId], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (blobResult.status !== 0 || !Buffer.isBuffer(blobResult.stdout)) {
      issues.push({ file: historyFile, category: "no se pudo inspeccionar un archivo histórico" });
      continue;
    }
    if (blobResult.stdout.includes(0)) {
      issues.push({ file: historyFile, category: "archivo binario histórico no permitido" });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(blobResult.stdout);
    } catch {
      issues.push({ file: historyFile, category: "archivo histórico no textual o UTF-8 inválido" });
      continue;
    }
    issues.push(...scanPublicText(text, historyFile));
  }
  return issues;
}

function listGitCandidateFiles(repositoryRoot: string): string[] {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error("No se pudieron enumerar los archivos públicos mediante Git.");
  }

  const candidates = result.stdout.toString("utf8")
    .split("\u0000")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""));
  return [...new Set(candidates)].sort((left, right) => left.localeCompare(right, "en"));
}

function isExcludedDirectory(relativeFile: string): boolean {
  const lower = relativeFile.toLowerCase();
  return lower === ".git" || lower.startsWith(".git/") || lower === "node_modules" || lower.startsWith("node_modules/");
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= index) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function deduplicateIssues(issues: PublicRepositoryIssue[]): PublicRepositoryIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.file}\u0000${issue.line ?? ""}\u0000${issue.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function redactRepositoryIssuePaths(issues: PublicRepositoryIssue[]): PublicRepositoryIssue[] {
  return issues.map((issue) => {
    const fingerprint = createHash("sha256").update(issue.file, "utf8").digest("hex").slice(0, 12);
    const scope = issue.file.startsWith("@history/") ? "historial" : "archivo";
    return { ...issue, file: `[${scope}-${fingerprint}]` };
  });
}

function sanitizeOutputPath(file: string): string {
  return file.replace(/[\u0000-\u001f\u007f]/g, "?");
}

async function runCli(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const issues = await validatePublicRepository(root);
  if (issues.length > 0) {
    console.error("PUBLIC_REPO_VALID=0");
    for (const issue of issues) {
      const location = issue.line ? `${sanitizeOutputPath(issue.file)}:${issue.line}` : sanitizeOutputPath(issue.file);
      console.error(`- ${location}: ${issue.category}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("PUBLIC_REPO_VALID=1");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await runCli();
}
