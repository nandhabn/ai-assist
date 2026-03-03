const STORAGE_KEYS = {
  EVENTS: "flowRecorder_events",
  SESSION_ID: "flowRecorder_sessionId",
  IS_RECORDING: "flowRecorder_isRecording",
  SESSIONS: "flowRecorder_sessions",
  LAST_USER_ACTION: "flowRecorder_lastUserAction",
  AGENT_ENABLED: "flowRecorder_agentEnabled",
} as const;

export async function getOrCreateSessionId(): Promise<string> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SESSION_ID]);

  if (data[STORAGE_KEYS.SESSION_ID]) {
    return data[STORAGE_KEYS.SESSION_ID];
  }

  const sessionId = `session_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_ID]: sessionId });

  return sessionId;
}

export async function createNewSessionId(): Promise<string> {
  const sessionId = `session_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_ID]: sessionId });
  return sessionId;
}

export async function saveEvent(event: any): Promise<void> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.EVENTS]);
  const events = data[STORAGE_KEYS.EVENTS] || [];

  events.push(event);

  await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: events });
}

export async function saveLastUserAction(event: any): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_USER_ACTION]: event });
}

export async function getEvents(): Promise<any[]> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.EVENTS]);
  return data[STORAGE_KEYS.EVENTS] || [];
}

export async function clearEvents(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: [] });
}

export async function isRecording(): Promise<boolean> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.IS_RECORDING]);
  return data[STORAGE_KEYS.IS_RECORDING] || false;
}

export async function setRecordingStatus(status: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.IS_RECORDING]: status });
}

export async function isAgentEnabled(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AGENT_ENABLED);
  // Default to false if the value is not explicitly set to true
  return data[STORAGE_KEYS.AGENT_ENABLED] === true;
}

export async function setAgentEnabled(status: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.AGENT_ENABLED]: status });
}

export async function saveSession(flowData: any): Promise<void> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SESSIONS]);
  const sessions = data[STORAGE_KEYS.SESSIONS] || [];

  sessions.push({ ...flowData, savedAt: Date.now() });

  await chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS]: sessions });
}

export async function getSessions(): Promise<any[]> {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SESSIONS]);
  return data[STORAGE_KEYS.SESSIONS] || [];
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  const filtered = sessions.filter((s) => s.sessionId !== sessionId);

  await chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS]: filtered });
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
}

export function exportEventsAsJSON(events: any[]): string {
  return JSON.stringify(events, null, 2);
}

export function watchStorage(callback: (changes: any) => void) {
  const handleStorageChange = (changes: any, areaName: string) => {
    if (areaName === "local") {
      callback(changes);
    }
  };

  chrome.storage.onChanged.addListener(handleStorageChange);

  return () => {
    chrome.storage.onChanged.removeListener(handleStorageChange);
  };
}
