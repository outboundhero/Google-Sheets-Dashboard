// Tunables for Turbo Mode + the auto-throttle (Nick's Performance & Turbo
// Mode spec, 2026-09-23). The spec asks for every number to be configuration
// "since we expect to adjust them after the manual month" — they live in the
// single-row sending_mode_settings table, with these defaults as the fallback
// when the row (or a newer column) isn't there yet.
import { getSupabaseAdmin } from "@/lib/supabase";

export interface SendingModeSettings {
  turboDays: number;            // how long a Turbo window runs
  turboWarmupLimit: number;     // warm-up/day in Turbo (normal 8)
  turboDailyLimit: number;      // campaign sends/day in Turbo (normal 5)
  throttleDailyLimit: number;   // campaign sends/day while throttled (normal 5)
  throttleOnPace: number;       // throttle at pace ≥ this (1.25 = 125%)
  throttleOffPace: number;      // release at pace < this (1.10)
  graceDays: number;            // no status / no throttle for the first N days of a period
  turboWindowDays: number;      // Critical when projected < guarantee with ≤ N days left
  fullCreditFraction: number;   // projected ≤ guarantee × this = 100%-credit band
}

export const DEFAULT_SENDING_MODE_SETTINGS: SendingModeSettings = {
  turboDays: 15,
  turboWarmupLimit: 5,
  turboDailyLimit: 8,
  throttleDailyLimit: 3,
  throttleOnPace: 1.25,
  throttleOffPace: 1.1,
  graceDays: 5,
  turboWindowDays: 15,
  fullCreditFraction: 0.5,
};

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

export async function getSendingModeSettings(): Promise<SendingModeSettings> {
  const d = DEFAULT_SENDING_MODE_SETTINGS;
  try {
    const { data } = await getSupabaseAdmin()
      .from("sending_mode_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (!data) return { ...d };
    return {
      turboDays: num(data.turbo_days, d.turboDays),
      turboWarmupLimit: num(data.turbo_warmup_limit, d.turboWarmupLimit),
      turboDailyLimit: num(data.turbo_daily_limit, d.turboDailyLimit),
      throttleDailyLimit: num(data.throttle_daily_limit, d.throttleDailyLimit),
      throttleOnPace: num(data.throttle_on_pace, d.throttleOnPace),
      throttleOffPace: num(data.throttle_off_pace, d.throttleOffPace),
      graceDays: num(data.grace_days, d.graceDays),
      turboWindowDays: num(data.turbo_window_days, d.turboWindowDays),
      fullCreditFraction: num(data.full_credit_fraction, d.fullCreditFraction),
    };
  } catch {
    return { ...d };
  }
}
