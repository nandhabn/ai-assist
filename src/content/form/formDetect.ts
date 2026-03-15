/**
 * Form detection, metadata extraction, and banner UI for the agent.
 */

import type { FormFieldInfo } from "@/types/ai";
import { showFormDetectedBanner, hideFormDetectedBanner } from "../agent/agentPanel";
import { generateAutofillData } from "./autofill";

// ─── Form detection ───────────────────────────────────────────────────────────

/** Detect forms on the page for the agent executor. */
export function detectFormForAgent(): {
  detected: boolean;
  fields: FormFieldInfo[];
  form: HTMLFormElement | null;
} {
  const forms = Array.from(document.querySelectorAll("form")).filter(
    (f) =>
      f.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select",
      ).length >= 1,
  );

  if (forms.length === 0) return { detected: false, fields: [], form: null };

  for (const form of forms) {
    const emptyInputs = Array.from(
      form.querySelectorAll<HTMLInputElement>(
        "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea",
      ),
    ).filter((input) => !input.value);

    if (emptyInputs.length >= 2) {
      const fields = buildFormFields(form);
      return { detected: true, fields, form };
    }
  }

  return { detected: false, fields: [], form: null };
}

/** Collect FormFieldInfo[] from a form element. */
function buildFormFields(form: HTMLFormElement): FormFieldInfo[] {
  const allElements = Array.from(form.querySelectorAll("input, textarea, select"));
  const processedRadioGroups = new Set<string>();

  return allElements
    .filter((el) => {
      const input = el as HTMLInputElement;
      const type = input.type?.toLowerCase();
      if (type === "submit" || type === "button" || type === "hidden") return false;
      if (type === "radio") {
        if (!input.name || processedRadioGroups.has(input.name)) return false;
        processedRadioGroups.add(input.name);
        return true;
      }
      if (type === "checkbox") return !input.checked;
      return !input.value;
    })
    .map((el) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const type =
        (input as HTMLInputElement).type?.toLowerCase() ||
        (input.tagName.toLowerCase() === "textarea" ? "textarea" : input.tagName.toLowerCase());

      let labelText = "";
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) labelText = label.textContent?.trim() || "";
      }
      if (!labelText) {
        const parentLabel = input.closest("label");
        if (parentLabel) labelText = parentLabel.textContent?.trim() || "";
      }
      const ariaLabel = input.getAttribute("aria-label")?.trim() || "";

      let options: string[] | undefined;
      if (input.tagName.toLowerCase() === "select") {
        options = Array.from((input as HTMLSelectElement).options)
          .filter((opt) => opt.value && opt.value !== "" && !opt.disabled)
          .map((opt) => opt.text.trim())
          .slice(0, 20);
      } else if (type === "radio" && (input as HTMLInputElement).name) {
        const radios = Array.from(
          form.querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${(input as HTMLInputElement).name}"]`,
          ),
        );
        options = radios
          .filter((r) => r.value && !r.disabled)
          .map((r) => {
            let radioLabel = "";
            if (r.id) {
              const lbl = document.querySelector(`label[for="${r.id}"]`);
              if (lbl) radioLabel = lbl.textContent?.trim() || "";
            }
            if (!radioLabel) {
              const parentLbl = r.closest("label");
              if (parentLbl) radioLabel = parentLbl.textContent?.trim() || "";
            }
            return radioLabel || r.value;
          })
          .slice(0, 20);
      }

      return {
        name: input.name || "",
        id: input.id || "",
        type,
        placeholder: (input as HTMLInputElement).placeholder || "",
        labelText,
        ariaLabel,
        options,
      };
    });
}

// ─── Form fill ────────────────────────────────────────────────────────────────

/** Fill a form using AI-generated data. Used by the agent executor. */
export async function fillFormForAgent(fields: FormFieldInfo[]): Promise<boolean> {
  try {
    const data = await generateAutofillData(fields);
    if (!data || Object.keys(data).length === 0) return false;

    const formInfo = detectFormForAgent();
    if (formInfo.form && (window as any).__fillFormElement) {
      await (window as any).__fillFormElement(formInfo.form, data, { debug: true, delay: 50 });
    } else if ((window as any).__fillActiveForm) {
      await (window as any).__fillActiveForm(data, { debug: true, delay: 50 });
    }
    return true;
  } catch (err) {
    console.error("[Agent] Form fill failed:", err);
    return false;
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

/** Detect forms on the current page and show/hide the banner accordingly. */
export function checkAndShowFormBanner(): void {
  const forms = Array.from(document.querySelectorAll("form")).filter(
    (f) =>
      f.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select",
      ).length >= 1,
  );

  if (forms.length === 0) {
    hideFormDetectedBanner();
    return;
  }

  const formEntries = forms.map((form, index) => {
    const ariaLabel = form.getAttribute("aria-label") || form.getAttribute("aria-labelledby");
    const idLabel = form.id ? `#${form.id}` : "";
    const heading = form
      .closest("section, main, article, div")
      ?.querySelector("h1, h2, h3, h4")
      ?.textContent?.trim();
    const submitBtn = form.querySelector<HTMLInputElement | HTMLButtonElement>(
      "button[type=submit], input[type=submit]",
    );
    const submitLabel = submitBtn?.textContent?.trim() || submitBtn?.value?.trim();
    const label =
      ariaLabel ||
      (idLabel && idLabel !== "#" ? idLabel : "") ||
      heading ||
      (submitLabel ? `Submit: ${submitLabel}` : "") ||
      `Form ${index + 1}`;

    return {
      label,
      onFocus: () => {
        const firstInput = form.querySelector<HTMLElement>(
          "input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
        );
        if (firstInput) {
          firstInput.scrollIntoView({ behavior: "smooth", block: "center" });
          firstInput.focus();
        } else {
          form.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      },
    };
  });

  showFormDetectedBanner(formEntries);
}
