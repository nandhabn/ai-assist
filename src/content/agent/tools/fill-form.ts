import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";

/**
 * fill_form tool — fills all currently-visible form fields from a label→value map.
 *
 * Single-pass by design: if a field is not found (e.g. it appears dynamically
 * after another field is changed), it is reported in the partial result and the
 * agent loop will call fill_form again after observing the updated DOM.
 *
 * Handles: text / email / number / tel / date / password inputs, textareas,
 * <select> dropdowns, checkboxes, radio buttons, and contenteditable elements.
 * Uses the React/Vue-compatible native setter so framework state machines see the change.
 */
export class FillFormTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const fields = params.fields;
    if (!fields || Object.keys(fields).length === 0) {
      return { success: false, failureReason: "fill_form: no fields provided." };
    }

    const filled: string[] = [];
    const notFound: string[] = [];
    const errored: string[] = [];

    for (const [fieldLabel, value] of Object.entries(fields)) {
      const target = this.#findField(fieldLabel);
      if (!target) {
        notFound.push(fieldLabel);
        continue;
      }

      const tag = target.tagName.toLowerCase();
      const inputType = (target as HTMLInputElement).type?.toLowerCase() ?? "";

      try {
        if (tag === "select") {
          this.#fillSelect(target as HTMLSelectElement, value);
        } else if (tag === "input" && inputType === "checkbox") {
          this.#fillCheckbox(target as HTMLInputElement, value);
        } else if (tag === "input" && inputType === "radio") {
          this.#fillRadio(target as HTMLInputElement, value, fieldLabel);
        } else if (tag === "input" || tag === "textarea") {
          this.#fillText(target as HTMLInputElement | HTMLTextAreaElement, value);
        } else if ((target as HTMLElement).isContentEditable) {
          this.#fillContentEditable(target as HTMLElement, value);
        } else {
          notFound.push(fieldLabel);
          continue;
        }
        filled.push(fieldLabel);
      } catch (e) {
        errored.push(`${fieldLabel} (${e instanceof Error ? e.message : "error"})`);
      }
    }

    if (filled.length === 0) {
      return {
        success: false,
        failureReason: `fill_form: could not fill any fields.${notFound.length ? ` Not found: ${notFound.join(", ")}.` : ""}${errored.length ? ` Errors: ${errored.join("; ")}.` : ""}`,
      };
    }

    const warnings: string[] = [];
    if (notFound.length > 0)
      warnings.push(`Fields not yet visible (may have appeared dynamically — call fill_form again): ${notFound.join(", ")}`);
    if (errored.length > 0)
      warnings.push(`Errors: ${errored.join("; ")}`);

    return {
      success: true,
      ...(warnings.length > 0 ? { failureReason: warnings.join(" | ") } : {}),
    };
  }

  // ── Field finders ────────────────────────────────────────────────────────

  /**
   * Find the best-matching form field for a given label string.
   * Priority: id/aria-labelledby → aria-label → placeholder → name → title
   * → associated <label> text → any visible text nearby.
   */
  #findField(label: string): HTMLElement | null {
    const needle = label.toLowerCase().trim();

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "input:not([type=hidden]), textarea, select",
      ),
    ).filter(
      (el) =>
        !el.closest("[data-flow-recorder]") &&
        !this.#isHidden(el),
    );

    // Score each candidate; return highest.
    let best: HTMLElement | null = null;
    let bestScore = -1;

    for (const el of candidates) {
      const score = this.#labelScore(el, needle);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return bestScore > 0 ? best : null;
  }

  /** Returns a match score (0 = no match) for a form element vs. needle label. */
  #labelScore(el: HTMLElement, needle: string): number {
    const checks: Array<() => string | null> = [
      // 1. aria-label (exact)
      () => el.getAttribute("aria-label"),
      // 2. aria-labelledby text
      () => {
        const ids = el.getAttribute("aria-labelledby");
        if (!ids) return null;
        return ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
      },
      // 3. associated <label for="..."> — first text node only (avoids nested price spans)
      () => {
        const id = el.id;
        if (!id) return null;
        const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
        if (!lbl) return null;
        return this.#firstTextNode(lbl);
      },
      // 4. placeholder
      () => el.getAttribute("placeholder"),
      // 5. name attribute
      () => el.getAttribute("name"),
      // 6. title
      () => el.getAttribute("title"),
      // 7. data-testid
      () => el.getAttribute("data-testid"),
      // 8. wrapping <label> first text node
      () => {
        const lbl = el.closest("label");
        return lbl ? this.#firstTextNode(lbl) : null;
      },
    ];

    for (let i = 0; i < checks.length; i++) {
      const raw = checks[i]();
      if (!raw) continue;
      const text = raw.replace(/\s+/g, " ").toLowerCase().trim();
      if (text === needle) return 100 - i;         // exact match
      if (text.includes(needle) || needle.includes(text)) return 50 - i; // partial
    }
    return 0;
  }

  /** Returns the text content of the first direct text node in an element. */
  #firstTextNode(el: HTMLElement): string | null {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (t) return t;
      }
    }
    return null;
  }

  /** Returns true if the element is not visible to the user. */
  #isHidden(el: HTMLElement): boolean {
    if ((el as HTMLInputElement).disabled) return true;
    const style = window.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  }

  // ── Fillers ──────────────────────────────────────────────────────────────

  /** Fill a text input or textarea (React / Vue compatible via native setter). */
  #fillText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const tag = el.tagName.toLowerCase();
    const proto =
      tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Fill a <select> dropdown by matching option text or option value. */
  #fillSelect(el: HTMLSelectElement, value: string): void {
    const needle = value.toLowerCase().trim();
    let matched = false;

    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if (
        opt.text.toLowerCase().trim() === needle ||
        opt.value.toLowerCase().trim() === needle
      ) {
        el.selectedIndex = i;
        matched = true;
        break;
      }
    }

    // Loose partial match fallback
    if (!matched) {
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        if (
          opt.text.toLowerCase().includes(needle) ||
          needle.includes(opt.text.toLowerCase().trim())
        ) {
          el.selectedIndex = i;
          matched = true;
          break;
        }
      }
    }

    if (!matched) throw new Error(`No option matching "${value}"`);

    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true }));
  }

  /** Check or uncheck a checkbox based on the value string. */
  #fillCheckbox(el: HTMLInputElement, value: string): void {
    const shouldCheck = ["true", "yes", "1", "checked", "on"].includes(
      value.toLowerCase().trim(),
    );
    if (el.checked !== shouldCheck) {
      el.click();
    }
  }

  /**
   * Select the correct radio button in a group.
   * Finds all radios with the same `name`, then picks the one whose value or
   * associated label text matches `value`.
   */
  #fillRadio(el: HTMLInputElement, value: string, _fieldLabel: string): void {
    const needle = value.toLowerCase().trim();
    const name = el.getAttribute("name");
    const radios = name
      ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`))
      : [el];

    for (const radio of radios) {
      const radioValue = radio.value.toLowerCase().trim();
      const radioLabel = radio.id
        ? (document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(radio.id)}"]`)?.textContent ?? "")
            .replace(/\s+/g, " ").toLowerCase().trim()
        : "";

      if (radioValue === needle || radioLabel === needle) {
        if (!radio.checked) radio.click();
        return;
      }
    }

    throw new Error(`No radio option matching "${value}"`);
  }

  /** Fill a contenteditable element (e.g. rich text editor). */
  #fillContentEditable(el: HTMLElement, value: string): void {
    el.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  }
}
