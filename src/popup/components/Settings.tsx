import React from "react";
import {
  getUserKeys,
  saveUserKeys,
  type UserKeys,
  type ProviderName,
} from "@/utils/storage";
import "../styles/Settings.css";

// ─── Model catalogue ──────────────────────────────────────────────────────────

const MODEL_OPTIONS: Record<ProviderName, { value: string; label: string }[]> =
  {
    gemini: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (default)" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
      { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
  };

const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: "gemini-2.5-flash",
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  gemini: "Gemini",
};

// ─── Active provider resolver (mirrors providers.ts logic, no imports) ────────

function resolveActiveProvider(
  keys: UserKeys,
): { provider: ProviderName; model: string } | null {
  const order: ProviderName[] = keys.preferredProvider
    ? [keys.preferredProvider]
    : ["gemini"];

  for (const p of order) {
    const hasKey = p === "gemini" && !!keys.gemini;

    if (hasKey) {
      const model =
        p === keys.preferredProvider && keys.preferredModel
          ? keys.preferredModel
          : DEFAULT_MODELS[p];
      return { provider: p, model };
    }
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Settings() {
  const [keys, setKeys] = React.useState<UserKeys>({});
  const [saved, setSaved] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    getUserKeys().then((stored) => {
      setKeys(stored);
      setLoading(false);
    });
  }, []);

  const handleChange =
    (field: keyof UserKeys) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setSaved(false);
      setKeys((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const provider = e.target.value as ProviderName;
    setSaved(false);
    setKeys((prev) => ({
      ...prev,
      preferredProvider: provider,
      // Reset model to default for new provider
      preferredModel: DEFAULT_MODELS[provider],
    }));
  };

  const handleSave = async () => {
    // Derive the currently-displayed values so they are always persisted even
    // if the user never explicitly touched those dropdowns (UI shows a default
    // but the underlying `keys` object still has undefined for those fields).
    const sp = (keys.preferredProvider ?? "gemini") as ProviderName;
    const sm = keys.preferredModel ?? DEFAULT_MODELS[sp];
    const effective: UserKeys = {
      ...keys,
      preferredProvider: sp,
      ...(sm ? { preferredModel: sm } : {}),
    };
    const cleaned: UserKeys = Object.fromEntries(
      Object.entries(effective).filter(
        ([, v]) => v && (v as string).trim() !== "",
      ),
    );
    await saveUserKeys(cleaned);
    setSaved(true);
  };

  const handleClear = async () => {
    await saveUserKeys({});
    setKeys({});
    setSaved(false);
  };

  if (loading)
    return (
      <div className="settings-panel">
        <p>Loading…</p>
      </div>
    );

  const active = resolveActiveProvider(keys);
  const selectedProvider = (keys.preferredProvider ?? "gemini") as ProviderName;
  const modelOptions = MODEL_OPTIONS[selectedProvider] ?? [];

  return (
    <div className="settings-panel">
      {/* ── Active status card ── */}
      <div
        className={`settings-status ${active ? "settings-status--active" : "settings-status--none"}`}
      >
        {active ? (
          <>
            <span className="settings-status__dot" />
            <span className="settings-status__text">
              <strong>{PROVIDER_LABELS[active.provider]}</strong>
              {active.model && (
                <>
                  {" "}
                  &middot; <code>{active.model}</code>
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="settings-status__dot settings-status__dot--off" />
            <span className="settings-status__text">
              No provider configured — add a key below
            </span>
          </>
        )}
      </div>

      {/* ── Provider preference ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">Provider &amp; Model</h3>

        <div className="settings-group">
          <label className="settings-label" htmlFor="pref-provider">
            Preferred provider
          </label>
          <select
            id="pref-provider"
            className="settings-select"
            value={selectedProvider}
            onChange={handleProviderChange}
          >
            <option value="gemini">Gemini</option>
          </select>
        </div>

        {modelOptions.length > 0 && (
          <div className="settings-group">
            <label className="settings-label" htmlFor="pref-model">
              Model
            </label>
            <select
              id="pref-model"
              className="settings-select"
              value={keys.preferredModel || DEFAULT_MODELS[selectedProvider]}
              onChange={handleChange("preferredModel")}
            >
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── API Keys ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">API Keys</h3>
        <p className="settings-hint">
          Stored locally — never leave your device.
        </p>

        <div className="settings-group">
          <label className="settings-label" htmlFor="gemini-key">
            Gemini API Key
            <a
              className="settings-link"
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer"
            >
              Get key ↗
            </a>
          </label>
          <input
            id="gemini-key"
            className="settings-input"
            type="password"
            placeholder="AIza…"
            value={keys.gemini || ""}
            onChange={handleChange("gemini")}
            autoComplete="off"
          />
        </div>


      </div>

      <div className="settings-actions">
        <button
          className="settings-btn settings-btn--save"
          onClick={handleSave}
        >
          {saved ? "✓ Saved" : "Save"}
        </button>
        <button
          className="settings-btn settings-btn--clear"
          onClick={handleClear}
        >
          Clear All
        </button>
      </div>
    </div>
  );
}
