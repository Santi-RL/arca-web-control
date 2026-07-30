import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { assertPrivateImportPath, parseCredentialCsv, sourceDeletionRequired } from "../src/config/credentialImport.js";
import { ensurePrivateDirectory, ensurePrivateFile, getRuntimePaths } from "../src/config/runtimePaths.js";

const [mode, confirmation] = process.argv.slice(2);
if (mode !== "--dry-run" && !(mode === "--write" && confirmation === "IMPORTAR_CREDENCIALES")) {
  throw new Error("Uso: arca:credentials:import-csv -- --dry-run | --write IMPORTAR_CREDENCIALES");
}

const importRoot = path.join(getRuntimePaths().root, "private-import");
await ensurePrivateDirectory(importRoot);
console.log(`IMPORT_FOLDER=${importRoot}`);
const terminal = readline.createInterface({ input, output });
let enteredPath: string;
try {
  enteredPath = (await terminal.question("Ruta local del CSV: ")).trim().replace(/^['\"]|['\"]$/g, "");
} finally {
  terminal.close();
}
if (!enteredPath) throw new Error("No se indicó el archivo CSV.");

const resolvedPath = await fs.realpath(enteredPath);
assertPrivateImportPath(resolvedPath, importRoot);
const stat = await fs.stat(resolvedPath);
if (!stat.isFile()) throw new Error("La ruta indicada no corresponde a un archivo regular.");
if (stat.size > 5 * 1024 * 1024) throw new Error("El CSV supera el límite de 5 MB.");
await ensurePrivateFile(resolvedPath);

const records = parseCredentialCsv(await fs.readFile(resolvedPath));
const operation = mode === "--dry-run" ? "import-json-plan" : "import-json";
const script = path.resolve("scripts", "windows-credential.ps1");
const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, operation], {
  input: JSON.stringify({ records }),
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 1024 * 1024,
});
if (child.status !== 0) throw new Error((child.stderr || "La importación de credenciales falló sin modificar el CSV.").trim());

const result = JSON.parse(child.stdout.trim()) as { dryRun: boolean; total: number; imported: number; skippedExisting: number };
console.log(`DRY_RUN=${result.dryRun ? 1 : 0}`);
console.log(`TOTAL_ROWS=${result.total}`);
console.log(`IMPORTED_COUNT=${result.imported}`);
console.log(`SKIPPED_EXISTING_COUNT=${result.skippedExisting}`);
console.log(`SOURCE_DELETE_REQUIRED=${sourceDeletionRequired(result.dryRun) ? 1 : 0}`);
