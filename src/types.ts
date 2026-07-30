export type ArcaCredentials = {
  /** Identidad canónica del emisor. Siempre es el CUIT de once dígitos. */
  issuerKey: string;
  /** Etiqueta descriptiva; puede repetirse entre contribuyentes. */
  displayName: string;
  cuit: string;
  clave: string;
};

export type RuntimeConfig = {
  headless: boolean;
  loginUrl: string;
  profileRoot: string;
  runtimeRoot: string;
  browserChannel?: "chrome" | "chromium" | "msedge";
};

export type SessionVisibilityMode = "visible" | "production-hidden";
export type CapabilityMaturity = "observed" | "assisted" | "automated_to_summary" | "controlled_irreversible" | "fast_path";
export type LearnedFlowCapability = string;

export type InvoiceJob = {
  schemaVersion: 2;
  operationId: string;
  issuerKey: string;
  recipientCuit: string;
  recipientName?: string;
  recipientVatCondition: string;
  recipientCommercialAddress?: string;
  voucherType: string;
  pointOfSale: string;
  date: string;
  concept: string;
  currency: "ARS";
  billingPeriodFrom?: string;
  billingPeriodTo?: string;
  dueDate?: string;
  specificRegime?: "meat-remit" | "flour-remit" | "conditioned-tobacco-remit";
  activity?: string;
  saleCondition: string;
  description: string;
  unit?: string;
  amount: string;
  outputDir: string;
};

export type ResolvedInvoiceJob = Omit<InvoiceJob, "amount"> & {
  amount: number;
  amountCents: number;
  amountDecimal: string;
};

export type RunInvoiceOptions = {
  guided: boolean;
  dryRun: boolean;
};
