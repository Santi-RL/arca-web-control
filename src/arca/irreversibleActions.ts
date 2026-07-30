const irreversibleActionWords = [
  "emitir",
  "confirmar",
  "presentar",
  "pagar",
  "enviar",
  "guardar",
  "eliminar",
  "borrar",
  "aceptar",
  "autorizar",
  "anular",
  "cancelar",
  "finalizar",
  "procesar",
  "liquidar",
] as const;

const irreversibleActionPattern = new RegExp(
  `\\b(?:${irreversibleActionWords.join("|")})\\b`,
  "i",
);

export function normalizeActionText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isIrreversibleActionText(value: string): boolean {
  return irreversibleActionPattern.test(normalizeActionText(value));
}
