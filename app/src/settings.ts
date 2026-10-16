export type Settings = {
  penalty: number; // % extra a non-preferred product must beat
  deliveryFee: number; // ₪ added to online stores
  minSplitSaving: number; // ₪ a two-store split must save
};

const DEFAULTS: Settings = { penalty: 15, deliveryFee: 30, minSplitSaving: 30 };
const KEY = "basket-settings";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
