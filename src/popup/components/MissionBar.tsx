import React from "react";
import "./MissionBar.css";

const STORAGE_KEY = "flowRecorder_missionPrompt";

export default function MissionBar() {
  const [draft, setDraft] = React.useState("");
  const [active, setActive] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "saved" | "cleared">(
    "idle",
  );
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Load persisted mission on mount
  React.useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const saved = data[STORAGE_KEY] || "";
      setActive(saved);
      setDraft(saved);
    });
    // Keep in sync across popup reopens
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (changes[STORAGE_KEY] !== undefined) {
        const val = changes[STORAGE_KEY].newValue || "";
        setActive(val);
        setDraft(val);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const broadcastAndSave = async (prompt: string) => {
    await chrome.storage.local.set({ [STORAGE_KEY]: prompt });
    // Push to every tab so content scripts pick it up immediately
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
      if (tab.id !== undefined) {
        chrome.tabs
          .sendMessage(tab.id, { action: "SET_MISSION_PROMPT", prompt })
          .catch(() => {});
      }
    });
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    await broadcastAndSave(trimmed);
    setActive(trimmed);
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 2000);
  };

  const handleClear = async () => {
    await broadcastAndSave("");
    setActive("");
    setDraft("");
    setStatus("cleared");
    setTimeout(() => setStatus("idle"), 2000);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter to save
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="mission-bar">
      <div className="mission-bar-header">
        <span className="mission-bar-title">🎯 Mission Prompt</span>
        {active && <span className="mission-bar-active-badge">Active</span>}
      </div>
      <textarea
        ref={textareaRef}
        className="mission-bar-input"
        placeholder='Describe what to do across pages… e.g. "Sign up with a test account and complete checkout"'
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
      />
      <div className="mission-bar-actions">
        <span className="mission-bar-hint">Ctrl+Enter to save</span>
        {active && (
          <button
            className="mission-bar-btn mission-bar-clear"
            onClick={handleClear}
          >
            Clear
          </button>
        )}
        <button
          className="mission-bar-btn mission-bar-save"
          onClick={handleSave}
          disabled={!draft.trim() || draft.trim() === active}
        >
          {status === "saved"
            ? "✓ Saved"
            : status === "cleared"
              ? "Cleared"
              : "Set Mission"}
        </button>
      </div>
    </div>
  );
}
