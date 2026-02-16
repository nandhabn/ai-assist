export function generateCSSSelector(element: HTMLElement): string {
  if (element.id) {
    return `#${escapeSelector(element.id)}`;
  }

  const path: string[] = [];
  let current: HTMLElement | null = element;

  while (current && current.nodeType === 1) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += `#${escapeSelector(current.id)}`;
      path.unshift(selector);
      break;
    }

    if ((current.className || "").toString()) {
      const classes = current.className
        .toString()
        .split(/\s+/)
        .filter(
          (c: string) => c && !c.startsWith("ng-") && !c.includes("react"),
        )
        .slice(0, 3);

      if (classes.length > 0) {
        selector += `.${classes.map(escapeSelector).join(".")}`;
      }
    }

    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (el) => el.tagName === current.tagName,
        )
      : [];

    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1;
      selector += `:nth-of-type(${index})`;
    }

    path.unshift(selector);

    if (current.id || (current.className && selector.includes("."))) {
      break;
    }

    current = current.parentElement as HTMLElement | null;
  }

  return path.join(" > ");
}

export function generateXPath(element: HTMLElement): string {
  if (element.id !== "") return `//*[@id='${element.id}']`;

  if (element === document.body) return "/html/body";

  const ix: string[] = [];
  let current: HTMLElement | null = element;

  while (current && current !== document.body) {
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (e) => e.tagName === current!.tagName,
        )
      : [];

    const sib_index = siblings.indexOf(current) + 1;

    ix.unshift(
      current.tagName.toLowerCase() +
        (siblings.length > 1 ? `[${sib_index}]` : ""),
    );

    current = current.parentElement as HTMLElement | null;
  }

  return "/" + ix.join("/");
}

function escapeSelector(str: string): string {
  return str.replace(/([!"#$%&'()*+,./:;?@[\\\]^`{|}~])/g, "\\$1");
}

export function isSelectorValid(selector: string): boolean {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

export function findElementBySelector(selector: string): HTMLElement | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}
