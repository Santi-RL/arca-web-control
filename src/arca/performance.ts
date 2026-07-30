import { performance } from "node:perf_hooks";

export type ArcaPerformanceStage =
  | "browser_launch"
  | "login_total"
  | "login_open_page"
  | "login_submit_identity"
  | "login_submit_secret"
  | "launcher_identity"
  | "launcher_runtime"
  | "launcher_runtime_handoff"
  | "launcher_spawn_ready"
  | "worker_runtime"
  | "worker_session_module"
  | "worker_credentials"
  | "worker_publish_ready"
  | "prepare_preflight"
  | "prepare_service_search_result"
  | "prepare_service_open"
  | "prepare_issuer_selection"
  | "prepare_ensure_rcel_menu"
  | "prepare_ledger_claim"
  | "prepare_open_generation"
  | "prepare_screen_point_of_sale"
  | "prepare_voucher_options"
  | "prepare_initial_data"
  | "prepare_screen_emission"
  | "prepare_emission_data"
  | "prepare_screen_recipient"
  | "prepare_recipient_data"
  | "prepare_recipient_autofill"
  | "prepare_screen_operation"
  | "prepare_operation_detail"
  | "prepare_total_ready"
  | "prepare_screen_summary"
  | "prepare_summary_validation"
  | "prepare_state_fingerprint"
  | "prepare_screenshot"
  | "chat_login_to_summary"
  | "emission_confirmation_to_pdf";

export type ArcaPerformanceOutcome = "ok" | "failed";

export function startArcaPerformance(stage: ArcaPerformanceStage): (outcome?: ArcaPerformanceOutcome) => number {
  const startedAt = performance.now();
  let completedDuration: number | undefined;
  return (outcome: ArcaPerformanceOutcome = "ok") => {
    if (completedDuration !== undefined) return completedDuration;
    completedDuration = Math.max(0, Math.round(performance.now() - startedAt));
    if (process.env.ARCA_PERF_TRACE === "1") {
      console.error(`ARCA_PERF stage=${stage} duration_ms=${completedDuration} outcome=${outcome}`);
    }
    return completedDuration;
  };
}

export async function measureArcaPerformance<T>(stage: ArcaPerformanceStage, action: () => Promise<T>): Promise<T> {
  const finish = startArcaPerformance(stage);
  let outcome: ArcaPerformanceOutcome = "failed";
  try {
    const result = await action();
    outcome = "ok";
    return result;
  } finally {
    finish(outcome);
  }
}
