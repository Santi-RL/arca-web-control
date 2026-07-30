export type SelectorAttempt = {
  action: "click" | "fill" | "select";
  description: string;
  candidate: string;
  result: "visible" | "not-visible" | "ambiguous" | "used" | "failed";
  visibleCount?: number;
};

export type FlowContext = {
  guided?: {
    checkpoint(page: import("playwright").Page, details: CheckpointDetails): Promise<void>;
    recordSelectorAttempt(attempt: SelectorAttempt): Promise<void>;
  };
  strictSelectors: boolean;
  interactive?: boolean;
  manualIntervention?: boolean;
};

export type CheckpointDetails = {
  title: string;
  expected: string;
  nextAction?: string;
};
