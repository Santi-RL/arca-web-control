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
  | "prepare_screenshot";

export async function measureArcaPerformance<T>(stage: ArcaPerformanceStage, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    if (process.env.ARCA_PERF_TRACE === "1") {
      const durationMs = Math.round(performance.now() - startedAt);
      console.log(`ARCA_PERF stage=${stage} duration_ms=${durationMs}`);
    }
  }
}
