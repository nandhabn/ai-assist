import type { APIDetails } from "@/types/index";

export function overrideFetch(
  onAPICall: (d: APIDetails & { timestamp?: number; error?: string }) => void,
) {
  const originalFetch = window.fetch.bind(window);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).fetch = async function (...args: any[]) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource?.url;
    const method = (config?.method || "GET").toUpperCase();

    const startTime = performance.now();

    try {
      const response = await originalFetch(...args);

      const duration = performance.now() - startTime;

      let payload: any = null;
      try {
        payload = config?.body ? JSON.parse(config.body) : null;
      } catch {}

      onAPICall({
        method,
        endpoint: url,
        payload,
        status: response.status,
        duration: Math.round(duration),
        timestamp: Date.now(),
      });

      return response;
    } catch (error: any) {
      const duration = performance.now() - startTime;

      let payload: any = null;
      try {
        payload = config?.body ? JSON.parse(config.body) : null;
      } catch {}

      onAPICall({
        method,
        endpoint: url,
        payload,
        status: 0,
        error: error?.message,
        duration: Math.round(duration),
        timestamp: Date.now(),
      });

      throw error;
    }
  };

  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).fetch = originalFetch;
  };
}

export function overrideXHR(
  onAPICall: (d: APIDetails & { timestamp?: number }) => void,
) {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  XMLHttpRequest.prototype.open = function (
    this: any,
    method: string,
    url: string,
  ) {
    this.__method = method;
    this.__url = url;
    this.__startTime = performance.now();

    return originalOpen.apply(this, arguments as any);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  XMLHttpRequest.prototype.send = function (this: any, data?: any) {
    const onreadystatechange = this.onreadystatechange;

    this.onreadystatechange = function (this: any) {
      if (this.readyState === 4) {
        const duration = performance.now() - this.__startTime;

        try {
          const payload = data ? JSON.parse(data) : null;

          onAPICall({
            method: this.__method,
            endpoint: this.__url,
            payload,
            status: this.status,
            duration: Math.round(duration),
            timestamp: Date.now(),
          });
        } catch {
          onAPICall({
            method: this.__method,
            endpoint: this.__url,
            status: this.status,
            duration: Math.round(duration),
            timestamp: Date.now(),
          });
        }
      }

      return onreadystatechange?.call(this);
    };

    return originalSend.apply(this, arguments as any);
  };

  return () => {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  };
}
