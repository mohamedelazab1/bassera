// Per-phone preferences. Storage can be unavailable (private mode, blocked
// site data), so every access is guarded and the app works without it.
const PREFIX = 'eyeon.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Not persisted - fine for a preference.
  }
}
