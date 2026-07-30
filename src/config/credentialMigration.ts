import dotenv from "dotenv";
import { ArcaCredentials } from "../types.js";
import { isValidCuit } from "../jobs/schema.js";

type EnvCredentialMigrationOptions = {
  environment?: NodeJS.ProcessEnv;
  envFile?: string;
};

export function normalizeIssuerKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function readEnvCredentialForMigration(
  issuerName: string,
  environment: NodeJS.ProcessEnv = process.env,
): ArcaCredentials {
  const displayName = issuerName.trim();
  const normalizedKey = normalizeIssuerKey(displayName);
  if (!normalizedKey) throw new Error("El nombre descriptivo para la migración no puede estar vacío.");

  const cuitVariable = `ARCA_CLIENT_${normalizedKey}_CUIT`;
  const secretVariable = `ARCA_CLIENT_${normalizedKey}_CLAVE`;
  const rawCuit = environment[cuitVariable];
  const clave = environment[secretVariable];
  if (!rawCuit || !clave || clave.trim() === "") {
    throw new Error(`Faltan ${cuitVariable}/${secretVariable} en el entorno de migración.`);
  }

  const cuit = rawCuit.replace(/\D/g, "");
  if (!isValidCuit(cuit)) throw new Error(`${cuitVariable} no contiene un CUIT válido.`);
  return { issuerKey: cuit, displayName, cuit, clave };
}

export function loadEnvCredentialForMigration(
  issuerName: string,
  options: EnvCredentialMigrationOptions = {},
): ArcaCredentials {
  const environment = options.environment ?? process.env;
  const explicitFile = options.envFile?.trim() || environment.ARCA_ENV_FILE?.trim();
  const result = dotenv.config({
    path: explicitFile || ".env.local",
    processEnv: environment,
    quiet: true,
    override: false,
  });
  if (explicitFile && result.error) {
    throw new Error("No se pudo leer el archivo de entorno indicado para la migración.");
  }
  return readEnvCredentialForMigration(issuerName, environment);
}
