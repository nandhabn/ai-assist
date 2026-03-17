/**
 * Shared DOM helpers used across agent tools.
 *
 * All functions are purely DOM-driven with no shared state dependency,
 * making them safe to call from any tool implementation.
 */

// ─── On-screen agent message toast ───────────────────────────────────────────

const TOAST_ID = "flow-recorder-agent-toast";

/**
 * Displays a toast banner on the page with the agent's message.
 * Automatically dismisses after `durationMs` milliseconds.
 * Calling it again while a toast is visible replaces the message.
 */
export function showAgentMessage(
  message: string,
  type: "info" | "success" | "error" = "info",
  durationMs = 6000,
): void {
  let toast = document.getElementById(TOAST_ID) as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      maxWidth: "380px",
      padding: "14px 18px",
      borderRadius: "10px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      transition: "opacity 0.3s ease",
      opacity: "0",
    } as Partial<CSSStyleDeclaration>);
    toast.dataset.flowRecorder = "true";
    document.body.appendChild(toast);
  }

  toast.style.pointerEvents = "auto";

  const colors: Record<typeof type, { bg: string; border: string; icon: string }> = {
    info:    { bg: "#1e293b", border: "#334155", icon: "ℹ️" },
    success: { bg: "#14532d", border: "#166534", icon: "✅" },
    error:   { bg: "#450a0a", border: "#7f1d1d", icon: "❌" },
  };
  const c = colors[type];
  Object.assign(toast.style, {
    background: c.bg,
    border: `1px solid ${c.border}`,
    color: "#f1f5f9",
  } as Partial<CSSStyleDeclaration>);
  toast.innerHTML =
    `<span style="font-size:18px;flex-shrink:0">${c.icon}</span>` +
    `<span style="flex:1">${message}</span>` +
    `<button id="${TOAST_ID}-close" style="background:none;border:none;color:#94a3b8;` +
    `font-size:16px;cursor:pointer;padding:0 0 0 8px;line-height:1;flex-shrink:0;` +
    `margin-top:-2px" title="Dismiss">\u2715</button>`;

  requestAnimationFrame(() => { toast!.style.opacity = "1"; });

  const dismiss = () => {
    toast!.style.opacity = "0";
    setTimeout(() => toast?.remove(), 400);
  };
  clearTimeout((toast as any)._dismissTimer);
  (toast as any)._dismissTimer = setTimeout(dismiss, durationMs);

  document
    .getElementById(`${TOAST_ID}-close`)
    ?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearTimeout((toast as any)._dismissTimer);
      dismiss();
    });
}

// ─── Element scoring ──────────────────────────────────────────────────────────

/** Computes a relevance score to rank duplicate-label candidates. Higher = better. */
export function scoreElement(el: HTMLElement): number {
  let score = 0;
  const rect = el.getBoundingClientRect();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  if (rect.top >= 0 && rect.bottom <= vpH && rect.left >= 0 && rect.right <= vpW)
    score += 10;
  else if (rect.top < vpH && rect.bottom > 0 && rect.left < vpW && rect.right > 0)
    score += 5;

  const area = rect.width * rect.height;
  if (area > 20) score += Math.min(4, Math.floor(area / 2000));

  if (
    el.getAttribute("aria-hidden") !== "true" &&
    el.closest('[aria-hidden="true"]') === null
  )
    score += 3;

  const tag = el.tagName.toLowerCase();
  if (["button", "a", "input", "select", "textarea"].includes(tag)) score += 2;
  const role = el.getAttribute("role");
  if (role && ["button", "link", "menuitem", "tab", "option"].includes(role))
    score += 2;

  if (!(el as HTMLButtonElement).disabled) score += 1;

  let maxZ = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.documentElement) {
    const z = parseInt(window.getComputedStyle(cur).zIndex ?? "auto", 10);
    if (!isNaN(z) && z > maxZ) maxZ = z;
    cur = cur.parentElement;
  }
  if (maxZ > 0) score += Math.min(8, Math.floor(Math.log10(maxZ + 1) * 3));

  const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="alertdialog"]';
  if (el.closest(MODAL_SELECTOR)) {
    score += 12;
  } else if (document.querySelector(MODAL_SELECTOR)) {
    score -= 8;
  }

  return score;
}

/** Returns a short CSS-path string for an element (used in disambiguation graph). */
export function buildDomPath(el: HTMLElement, depth = 4): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  for (let i = 0; i < depth && cur && cur !== document.body; i++) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? `#${cur.id}` : "";
    const testid = cur.getAttribute("data-testid")
      ? `[data-testid="${cur.getAttribute("data-testid")}"]`
      : "";
    const roleAttr =
      !id && !testid && cur.getAttribute("role")
        ? `[role="${cur.getAttribute("role")}"]`
        : "";
    parts.unshift(`${tag}${id}${testid}${roleAttr}`);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/**
 * Returns the primary human-readable label text for an element.
 * Checks aria-label, data-testid, title, placeholder, then textContent.
 */
export function elementLabelText(el: HTMLElement): string {
  return (
    el.getAttribute("aria-label") ??
    el.getAttribute("data-testid") ??
    el.getAttribute("title") ??
    el.getAttribute("placeholder") ??
    el.textContent ??
    ""
  )
    .replace(/\s+/g, " ") // normalize newlines + multiple spaces before matching
    .toLowerCase()
    .trim();
}

// ─── Element finders ──────────────────────────────────────────────────────────

export interface LabelCandidate {
  el: HTMLElement;
  score: number;
  domPath: string;
}

/**
 * Returns ALL visible interactive elements that match `label`, sorted by
 * relevance score descending.
 */
export function findAllElementsByLabel(label: string): LabelCandidate[] {
  const needle = label.toLowerCase().trim();
  const selectors = [
    "button",
    "a",
    "input:not([type=hidden])",
    "select",
    "textarea",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    "[tabindex]",
  ].join(",");

  const visible = Array.from(
    document.querySelectorAll<HTMLElement>(selectors),
  ).filter((el) => {
    const s = window.getComputedStyle(el);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      (el.offsetWidth > 0 || el.offsetHeight > 0)
    );
  });

  const seen = new Set<HTMLElement>();
  const matched: HTMLElement[] = [];

  /**
   * Returns all human-readable label candidates for an element.
   * Checking every source (aria-label, title, placeholder, textContent, data-testid)
   * ensures inner text is always tried even when other attributes are present.
   */
  const labelTexts = (el: HTMLElement): string[] => {
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
      el.textContent,
      el.getAttribute("data-testid"),
    ]
      .filter((v): v is string => v !== null && v !== "")
      .map((v) => v.replace(/\s+/g, " ").toLowerCase().trim())
      .filter((v) => v.length > 0);
  };

  for (const tier of [
    (t: string) => t === needle,
    (t: string) => t.startsWith(needle),
    (t: string) => t.includes(needle),
  ]) {
    for (const el of visible) {
      if (!seen.has(el) && labelTexts(el).some(tier)) {
        seen.add(el);
        matched.push(el);
      }
    }
  }

  return matched
    .map((el) => ({ el, score: scoreElement(el), domPath: buildDomPath(el) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Builds a human-readable disambiguation graph for AI error feedback.
 *
 * Example output:
 *   3 elements match "Post":
 *   [1] score=18  main > div[data-testid="toolBar"] > button  pos=(1200,40)
 */
export function buildDisambiguationGraph(
  label: string,
  candidates: LabelCandidate[],
): string {
  const lines = [`${candidates.length} elements match "${label}":`];
  for (let i = 0; i < candidates.length; i++) {
    const { el, score, domPath } = candidates[i];
    const rect = el.getBoundingClientRect();
    const snippet = (el.textContent ?? "").trim().slice(0, 40).replace(/\s+/g, " ");
    lines.push(
      `  [${i + 1}] score=${score}  ${domPath}  pos=(${Math.round(rect.left)},${Math.round(rect.top)})` +
        (snippet ? `  text="${snippet}"` : ""),
    );
  }
  lines.push(
    "To target a specific one, refine the label (e.g. add the data-testid value or parent context).",
  );
  return lines.join("\n");
}

/**
 * Finds the best-matching interactive element for a label.
 * When multiple elements share the same label the highest-scored candidate is returned.
 */
export function findElementByLabel(label: string): HTMLElement | null {
  const candidates = findAllElementsByLabel(label);
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    console.log(`[Agent] "${label}" matched ${candidates.length} elements — using top-scored:`);
    candidates.forEach(({ score, domPath }, i) =>
      console.log(`  [${i + 1}] score=${score}  ${domPath}`),
    );
  }

  return candidates[0].el;
}

/**
 * Finds the best matching <a> element and returns its resolved href, or null.
 * Matching priority: exact text → starts-with → includes → aria-label/title.
 */
export function findNavHrefByLabel(label: string): string | null {
  const needle = label.toLowerCase().trim();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const valid = anchors.filter((a) => {
    const h = a.getAttribute("href") ?? "";
    return h && !h.startsWith("#") && !h.startsWith("javascript:");
  });

  const exact = valid.find((a) => (a.textContent ?? "").toLowerCase().trim() === needle);
  if (exact) return exact.href;
  const starts = valid.find((a) =>
    (a.textContent ?? "").toLowerCase().trim().startsWith(needle),
  );
  if (starts) return starts.href;
  const includes = valid.find((a) =>
    (a.textContent ?? "").toLowerCase().includes(needle),
  );
  if (includes) return includes.href;

  const attrMatch = valid.find((a) =>
    [
      (a.getAttribute("aria-label") ?? "").toLowerCase(),
      (a.getAttribute("title") ?? "").toLowerCase(),
    ].some((v) => v === needle || v.includes(needle)),
  );
  return attrMatch ? attrMatch.href : null;
}

/**
 * Extracts a navigation URL from an AI prediction label or a plan step text.
 * Handles patterns like "Navigate to https://...", "Go to https://...", bare URLs.
 */
export function extractNavigationUrl(
  label: string,
  plan?: string,
  currentPlanStep?: number,
): string | null {
  const urlRe = /https?:\/\/[^\s"'>)]+/;

  const labelMatch = label.match(urlRe);
  if (labelMatch) return labelMatch[0];

  const lcLabel = label.toLowerCase();
  const isNavIntent =
    lcLabel.startsWith("navigate") ||
    lcLabel.startsWith("go to") ||
    lcLabel.startsWith("open") ||
    lcLabel.startsWith("visit") ||
    lcLabel.includes("navigate to");

  if (isNavIntent && plan && currentPlanStep != null) {
    const lines = plan.split("\n");
    const stepPatterns = [
      new RegExp(`^\\s*${currentPlanStep}[.):]?\\s`, "i"),
      new RegExp(`step\\s*${currentPlanStep}[.):]?\\s`, "i"),
    ];
    for (const line of lines) {
      if (stepPatterns.some((re) => re.test(line))) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
    for (const line of lines) {
      if (/navigate|go to|open|visit/i.test(line)) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
  }

  return null;
}
