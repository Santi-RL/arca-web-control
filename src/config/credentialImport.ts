import path from "node:path";
import { isValidCuit } from "../jobs/schema.js";

export type CredentialImportRecord = {
  displayName: string;
  cuit: string;
  clave: string;
};

export function sourceDeletionRequired(dryRun: boolean): boolean {
  return !dryRun;
}

const EXPECTED_HEADERS = ["Contribuyente", "CUIT", "Clave ARCA"] as const;
const MAX_ROWS = 10_000;

export function parseCredentialCsv(buffer: Buffer): CredentialImportRecord[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("El CSV debe estar codificado como UTF-8.");
  }

  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) throw new Error("El CSV está vacío.");
  const [headerRow] = rows;
  if (!headerRow) throw new Error("El CSV está vacío.");
  const headers = headerRow.map((value) => value.trim());
  if (headers.length !== EXPECTED_HEADERS.length || !EXPECTED_HEADERS.every((header, index) => headers[index] === header)) {
    throw new Error('El CSV debe contener exactamente las columnas "Contribuyente", "CUIT" y "Clave ARCA", en ese orden.');
  }

  const dataRows = rows.slice(1).filter((row) => row.some((value) => value.length > 0));
  if (dataRows.length === 0) throw new Error("El CSV no contiene contribuyentes.");
  if (dataRows.length > MAX_ROWS) throw new Error(`El CSV supera el máximo de ${MAX_ROWS} registros.`);

  const seen = new Map<string, number>();
  return dataRows.map((row, index) => {
    const sourceRow = index + 2;
    if (row.length !== EXPECTED_HEADERS.length) throw new Error(`La fila ${sourceRow} no tiene exactamente tres columnas.`);
    const [rawDisplayName, rawCuit, clave] = row;
    if (rawDisplayName === undefined || rawCuit === undefined || clave === undefined) throw new Error(`La fila ${sourceRow} no tiene exactamente tres columnas.`);
    const displayName = rawDisplayName.trim();
    if (!/^\s*[\d.\-\s]+\s*$/.test(rawCuit)) throw new Error(`La fila ${sourceRow} contiene un CUIT inválido.`);
    const cuit = rawCuit.replace(/\D/g, "");
    if (!displayName) throw new Error(`La fila ${sourceRow} no tiene contribuyente.`);
    if (displayName.length > 200 || /[\u0000-\u001F\u007F]/.test(displayName)) throw new Error(`La fila ${sourceRow} contiene un contribuyente inválido.`);
    if (!isValidCuit(cuit)) throw new Error(`La fila ${sourceRow} contiene un CUIT inválido.`);
    if (!clave || !clave.trim()) throw new Error(`La fila ${sourceRow} no tiene clave ARCA.`);
    if (clave.length > 1024 || /[\u0000\r\n]/.test(clave)) throw new Error(`La fila ${sourceRow} contiene una clave ARCA fuera del límite admitido.`);
    const firstRow = seen.get(cuit);
    if (firstRow !== undefined) throw new Error(`El CSV repite un mismo CUIT en las filas ${firstRow} y ${sourceRow}.`);
    seen.set(cuit, sourceRow);
    return { displayName, cuit, clave };
  });
}

export function assertPrivateImportPath(filePath: string, importRoot: string): void {
  const relative = path.relative(path.resolve(importRoot), path.resolve(filePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("El CSV debe estar dentro de la carpeta privada de importación indicada por el comando.");
  }
  if (path.extname(filePath).toLowerCase() !== ".csv") throw new Error("El archivo de importación debe tener extensión .csv.");
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new Error("El CSV tiene una estructura inválida.");
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) throw new Error("El CSV tiene una estructura inválida.");
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("El CSV tiene una estructura inválida.");
  if (field.length > 0 || row.length > 0 || closedQuote) finishRow();
  return rows;
}
