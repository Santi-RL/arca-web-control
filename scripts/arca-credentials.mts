import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvCredentialForMigration } from "../src/config/credentialMigration.js";
import { saveWindowsCredentialFromJson } from "../src/config/credentials.js";

const [operation, selector, confirmation] = process.argv.slice(2);
const script = path.resolve("scripts", "windows-credential.ps1");

if (operation === "set") {
  if (!selector) throw new Error('Uso: arca:credentials:set -- "<nombre descriptivo>"');
  runInteractive("set", selector);
} else if (operation === "list") {
  runInteractive("list");
} else if (operation === "delete") {
  if (!selector || confirmation !== "ELIMINAR_CREDENCIAL") {
    throw new Error("Uso: arca:credentials:delete -- <cuit> ELIMINAR_CREDENCIAL");
  }
  runInteractive("delete", selector);
} else if (operation === "update") {
  if (!selector || confirmation !== "ACTUALIZAR_CREDENCIAL") {
    throw new Error("Uso: arca:credentials:update -- <cuit> ACTUALIZAR_CREDENCIAL");
  }
  runInteractive("update", selector);
} else if (operation === "migrate-env") {
  if (!selector) throw new Error('Uso: arca:credentials:migrate-env -- "<nombre descriptivo>"');
  const credential = loadEnvCredentialForMigration(selector);
  saveWindowsCredentialFromJson(credential);
  console.log("CREDENTIAL_MIGRATED=1");
} else if (operation === "migrate-vault") {
  if (selector === "--dry-run") {
    runInteractive("migrate-vault-plan");
  } else if (selector === "--write" && confirmation === "MIGRAR_CREDENCIALES") {
    runInteractive("migrate-vault");
  } else {
    throw new Error("Uso: arca:credentials:migrate-vault -- --dry-run | --write MIGRAR_CREDENCIALES");
  }
} else {
  throw new Error("Operación de credenciales desconocida.");
}

function runInteractive(action: string, value?: string): void {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, action];
  if (value) args.push(value);
  const result = spawnSync("powershell.exe", args, { stdio: "inherit", windowsHide: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
