import type { ElementMetadata } from '@/types/index';

export function extractElementMetadata(element: HTMLElement): ElementMetadata {
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: element.className || undefined,
    innerText: (element.innerText || '').trim().substring(0, 100),
    name: (element as HTMLInputElement).name || undefined,
    type: (element as HTMLInputElement).type || undefined,
    role: element.getAttribute('role') || undefined,
    ariaLabel: element.getAttribute('aria-label') || undefined,
    dataTestId: element.getAttribute('data-testid') || undefined,
  } as ElementMetadata;
}

export function isFormElement(element: HTMLElement | null): boolean {
  if (!element) return false;
  const formTags = ['input', 'textarea', 'select', 'button'];
  let current: HTMLElement | null = element;

  while (current) {
    if (current.tagName.toLowerCase() === 'form') {
      return true;
    }
    if (formTags.includes(current.tagName.toLowerCase())) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

export function getParentForm(element: HTMLElement | null): HTMLFormElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.tagName.toLowerCase() === 'form') {
      return current as HTMLFormElement;
    }
    current = current.parentElement;
  }
  return null;
}

export function extractFormData(form: HTMLFormElement): Record<string, any> {
  const formData = new FormData(form);
  const data: Record<string, any> = {};

  for (const [key, value] of Array.from(formData.entries())) {
    if (data[key]) {
      if (Array.isArray(data[key])) {
        (data[key] as any[]).push(value);
      } else {
        data[key] = [data[key], value];
      }
    } else {
      data[key] = value;
    }
  }

  return data;
}

export function isClickable(element: HTMLElement): boolean {
  const clickableTags = ['button', 'a', 'input', 'select', 'textarea', 'label'];

  if (clickableTags.includes(element.tagName.toLowerCase())) {
    return true;
  }

  const onclick = (element as any).onclick || element.getAttribute('onclick');
  if (onclick) return true;

  const role = element.getAttribute('role');
  if (role && ['button', 'link', 'tab', 'menuitem'].includes(role)) {
    return true;
  }

  return false;
}

export function isElementVisible(element: HTMLElement | null): boolean {
  if (!element) return false;

  const style = window.getComputedStyle(element);

  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  return true;
}

export function getElementPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    visible: isElementVisible(element),
  };
}
