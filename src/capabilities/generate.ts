import fs from "node:fs/promises";
import path from "node:path";
import { CapabilityManifest } from "./registry.js";

const commands = [
  ["arca:credentials:set", "Alta interactiva por CUIT único en el Administrador de credenciales de Windows."],
  ["arca:credentials:list", "Lista contribuyentes por CUIT y nombre sin mostrar claves."],
  ["arca:credentials:update", "Actualiza por CUIT con confirmación ACTUALIZAR_CREDENCIAL."],
  ["arca:credentials:delete", "Elimina por CUIT con confirmación ELIMINAR_CREDENCIAL."],
  ["arca:credentials:migrate-env", "Migra temporalmente desde .env.local."],
  ["arca:credentials:migrate-vault", "Migra explícitamente credenciales legacy al esquema canónico por CUIT."],
  ["arca:credentials:import-csv", "Importa localmente un CSV privado con simulación, CUIT único y rollback."],
  ["arca:credentials:provider", "Consulta o selecciona Windows o un archivo JSON externo administrado por el usuario."],
  ["arca:issuer:resolve", "Resuelve rápidamente un emisor sobre el índice no secreto y propone candidatos sin cargar claves."],
  ["arca:invoice:prepare-chat", "Valida datos conversacionales, crea o reutiliza el job privado idempotente, inicia o reutiliza Chrome visible y devuelve el resumen."],
  ["arca:session:start", "Inicia una sesión y exige READY_STATE=portal; la revalidación irreversible requiere un modo visible explícito y exclusivo."],
  ["arca:session:cmd", "Ejecuta comandos tipados sobre la sesión actual; emit-prepared-invoice exige preparedInvoiceId vigente y EMITIR, y revalidate-prepared-invoice queda reservado a validación controlada."],
  ["arca:session:stop", "Cierra la sesión de forma controlada."],
  ["arca:learn:start", "Inicia aprendizaje visible; ante captcha conserva Chrome y publica el estado pausado."],
  ["arca:learn:cmd", "Reanuda explícitamente una pausa de autenticación, inspecciona y controla de forma híbrida la sesión visible, agrega evidencia o finaliza el candidato."],
  ["arca:job:migrate", "Migra jobs v1 a schemaVersion 2."],
  ["arca:job:create", "Crea o reutiliza un job v2 idempotente desde JSON recibido por stdin y devuelve un identificador opaco."],
  ["arca:runtime:repair", "Migra o repara explícitamente las ACL administradas y escribe el marcador de layout; nunca se ejecuta en el hot path."],
  ["arca:capability:sync", "Regenera documentación y referencias de la skill."],
  ["arca:capability:check", "Verifica manifiestos, evidencia y sincronización."],
  ["arca:capability:promote", "Promueve madurez con aprobación humana explícita."],
  ["arca:mcp", "Inicia el MCP local stdio."],
  ["arca:issuer:profile", "Consulta o configura regímenes específicos por CUIT sin mezclar datos con la credencial."],
  ["arca:invoice:recover-pdf", "Recupera un PDF, valida número/CAE/hash, publica PDF y metadatos en el archivo canónico y reconcilia un ledger unknown."],
] as const;

export function renderCapabilities(manifests: CapabilityManifest[]): string {
  const rows = manifests.map((item) => `| \`${item.id}\` | ${item.title} | \`${item.maturity}\` | ${item.hiddenAllowed ? "Sí" : "No"} | ${renderVisibleValidation(item)} |`).join("\n");
  return `# Capacidades ARCA\n\nDocumento generado desde \`config/capabilities/*.json\`. No editar manualmente.\n\n| ID | Capacidad | Madurez | Modo oculto | Última validación |\n|---|---|---|---|---|\n${rows}\n`;
}

function renderVisibleValidation(manifest: CapabilityManifest): string {
  if (manifest.lastValidatedVisible && manifest.lastValidatedAt) {
    return manifest.lastValidatedAt;
  }
  if (manifest.realEvidence.length > 0) {
    return "Versión actual: pendiente de revalidación visible";
  }
  return "Sin validar";
}

export function renderSkillCapabilities(manifests: CapabilityManifest[]): string {
  return `# Referencia de capacidades\n\nArchivo generado. Consultar el manifiesto canónico antes de operar.\n\n${manifests.map((item) => `## ${item.title}\n\n- ID: \`${item.id}\`\n- Madurez: \`${item.maturity}\`\n- Modo oculto: ${item.hiddenAllowed ? "permitido" : "prohibido"}\n- Alcance runtime: ${renderRuntimeScope(item)}\n- Comandos: ${item.commands.map((command) => `\`${command}\``).join(", ")}\n- Acción irreversible: ${item.irreversibleAction ?? "Ninguna"}\n- Confirmación: ${item.confirmation ? `\`${item.confirmation}\`` : "No aplica"}\n- Validación visible: ${renderVisibleValidation(item)}\n- Recuperación: ${item.recovery}\n`).join("\n")}`;
}

function renderRuntimeScope(manifest: CapabilityManifest): string {
  const scope = manifest.runtimeScope;
  if (scope?.kind !== "invoice") return "No aplica";
  return `\`${scope.voucherType}\` / \`${scope.concept}\` / \`${scope.currency}\` / ${scope.itemCount} ítem${scope.itemCount === 1 ? "" : "s"} / receptor \`${scope.recipientKind}\``;
}

export function renderSkillCommands(manifests: CapabilityManifest[]): string {
  const emissionEnabled = manifests.some((manifest) => manifest.commands.includes("emit-prepared-invoice")
    && manifest.maturity === "controlled_irreversible"
    && manifest.lastValidatedVisible);
  const emissionStatus = emissionEnabled
    ? "La emisión habilitada se ejecuta con `npm run arca:session:cmd -- emit-prepared-invoice <preparedInvoiceId> EMITIR`."
    : "La emisión está deshabilitada por los manifiestos vigentes. `emit-prepared-invoice` no debe ejecutarse hasta una revalidación visible y promoción humana.";
  return `# Comandos versionados\n\nArchivo generado desde el registro de comandos del proyecto. No editar manualmente.\n\n${commands.map(([command, description]) => `- \`npm run ${command}\`: ${description}`).join("\n")}\n\n${emissionStatus}\n`;
}

export async function writeGeneratedCapabilities(manifests: CapabilityManifest[]): Promise<void> {
  const references = path.resolve(".agents", "skills", "arca-web-control", "references");
  await fs.mkdir("docs", { recursive: true });
  await fs.mkdir(references, { recursive: true });
  await fs.writeFile(path.resolve("docs", "capacidades.md"), renderCapabilities(manifests), "utf8");
  await fs.writeFile(path.join(references, "capabilities.md"), renderSkillCapabilities(manifests), "utf8");
  await fs.writeFile(path.join(references, "commands.md"), renderSkillCommands(manifests), "utf8");
}
