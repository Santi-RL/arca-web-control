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

type IdentifiedInvoiceRecipient = {
  /** La ausencia conserva el contrato histórico de receptor identificado por CUIT. */
  recipientKind?: never;
  recipientCuit: string;
  recipientName?: string;
  recipientVatCondition: string;
  recipientCommercialAddress?: string;
};

type AnonymousFinalConsumerInvoiceRecipient = {
  recipientKind: "anonymous-final-consumer";
  recipientVatCondition: "Consumidor Final";
  recipientCuit?: never;
  recipientName?: never;
  recipientCommercialAddress?: never;
};

type InvoiceJobFields = {
  schemaVersion: 2;
  operationId: string;
  issuerKey: string;
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
  /** Base privada opcional. La estructura final por emisor se genera automáticamente. */
  outputDir?: string;
};

export type InvoiceJob = InvoiceJobFields & (IdentifiedInvoiceRecipient | AnonymousFinalConsumerInvoiceRecipient);

type ResolveInvoiceJob<T extends InvoiceJob> = T extends InvoiceJob ? Omit<T, "amount" | "outputDir"> & {
  amount: number;
  amountCents: number;
  amountDecimal: string;
  outputDir: string;
} : never;

export type ResolvedInvoiceJob = ResolveInvoiceJob<InvoiceJob>;

export type RunInvoiceOptions = {
  guided: boolean;
  dryRun: boolean;
};
