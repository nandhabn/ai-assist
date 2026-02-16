type RouteChange = {
  previousRoute?: string;
  newRoute?: string;
  url?: string;
};

export function detectRouteChanges(callback: (info: RouteChange) => void) {
  let lastRoute = window.location.pathname;

  const checkRoute = () => {
    const newRoute = window.location.pathname;
    if (newRoute !== lastRoute) {
      const prev = lastRoute;
      lastRoute = newRoute;
      callback({
        previousRoute: prev,
        newRoute: newRoute,
        url: window.location.href,
      });
    }
  };

  const observer = new MutationObserver(checkRoute);
  observer.observe(document, {
    subtree: true,
    childList: true,
  });

  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.history as any).pushState = function (...args: any[]) {
    const result = originalPushState.apply(this, args as any);
    checkRoute();
    return result;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.history as any).replaceState = function (...args: any[]) {
    const result = originalReplaceState.apply(this, args as any);
    checkRoute();
    return result;
  };

  window.addEventListener("popstate", checkRoute);

  return () => {
    observer.disconnect();
    (window.history as any).pushState = originalPushState;
    (window.history as any).replaceState = originalReplaceState;
    window.removeEventListener("popstate", checkRoute);
  };
}

export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "";
  }
}

export function isDifferentPage(url1: string, url2: string): boolean {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);

    if (u1.hostname !== u2.hostname) return true;

    const path1 = u1.pathname.split("/").filter(Boolean);
    const path2 = u2.pathname.split("/").filter(Boolean);

    if (path1.length === 0 && path2.length > 0) return true;
    if (path1.length > 0 && path2.length === 0) return true;

    if (path1[0] !== path2[0]) return true;

    return false;
  } catch {
    return true;
  }
}

export function sanitizeURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const trackingParams = ["utm_", "fbclid", "gclid", "msclkid", "_ga"];

    trackingParams.forEach((param) => {
      const keys = [...urlObj.searchParams.keys()];
      keys.forEach((key) => {
        if (key.startsWith(param)) {
          urlObj.searchParams.delete(key);
        }
      });
    });

    return urlObj.toString();
  } catch {
    return url;
  }
}

export function getCurrentRoute(): string {
  return window.location.pathname;
}

export function getCurrentURL(): string {
  return window.location.href;
}
