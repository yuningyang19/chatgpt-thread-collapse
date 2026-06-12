(function () {
  "use strict";

  const FLAG = "__CGPT_LITE_PAGE_OBSERVER__";
  const EVENT_NAME = "cgpt-lite:network";
  const INTERESTING_PATHS = [
    "/backend-api/",
    "/public-api/",
    "/conversation",
    "/conversations",
    "/responses",
    "/thread"
  ];
  const INTERESTING_HOSTS = /(^|\.)openai\.com$|(^|\.)chatgpt\.com$/i;

  if (window[FLAG]) {
    return;
  }
  window[FLAG] = true;

  patchFetch();
  patchXhr();

  function patchFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = function patchedFetch(input, init) {
      const url = getRequestUrl(input);
      const method = getRequestMethod(input, init);
      const track = isInterestingUrl(url);

      if (track) {
        emit({ type: "fetch:start", method, url });
      }

      try {
        return originalFetch.apply(this, arguments).then((response) => {
          if (track) {
            emit({
              type: "fetch:response",
              method,
              url,
              status: response.status,
              contentType: response.headers.get("content-type") || "",
              contentLength: response.headers.get("content-length") || ""
            });
          }
          return response;
        }, (error) => {
          if (track) {
            emit({ type: "fetch:error", method, url });
          }
          throw error;
        });
      } catch (error) {
        if (track) {
          emit({ type: "fetch:error", method, url });
        }
        throw error;
      }
    };
  }

  function patchXhr() {
    const Xhr = window.XMLHttpRequest;
    if (typeof Xhr !== "function") {
      return;
    }

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;

    Xhr.prototype.open = function patchedOpen(method, url) {
      this.__cgptLiteNetwork = {
        method: String(method || "GET").toUpperCase(),
        url: normalizeUrl(url)
      };
      return originalOpen.apply(this, arguments);
    };

    Xhr.prototype.send = function patchedSend() {
      const meta = this.__cgptLiteNetwork || {};
      const track = isInterestingUrl(meta.url);

      if (track) {
        emit({ type: "xhr:start", method: meta.method, url: meta.url });
        this.addEventListener("loadend", () => {
          emit({
            type: "xhr:response",
            method: meta.method,
            url: meta.url,
            status: this.status || 0,
            contentType: getHeaderSafely(this, "content-type"),
            contentLength: getHeaderSafely(this, "content-length")
          });
        }, { once: true });
      }

      return originalSend.apply(this, arguments);
    };
  }

  function getRequestUrl(input) {
    if (typeof input === "string") {
      return normalizeUrl(input);
    }
    if (input instanceof URL) {
      return input.href;
    }
    if (input instanceof Request) {
      return normalizeUrl(input.url);
    }
    return "";
  }

  function getRequestMethod(input, init) {
    if (init && init.method) {
      return String(init.method).toUpperCase();
    }
    if (input instanceof Request && input.method) {
      return String(input.method).toUpperCase();
    }
    return "GET";
  }

  function normalizeUrl(url) {
    try {
      return new URL(String(url || ""), location.href).href;
    } catch (error) {
      return "";
    }
  }

  function isInterestingUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return INTERESTING_HOSTS.test(parsed.hostname)
        && INTERESTING_PATHS.some((path) => parsed.pathname.includes(path));
    } catch (error) {
      return false;
    }
  }

  function getHeaderSafely(xhr, name) {
    try {
      return xhr.getResponseHeader(name) || "";
    } catch (error) {
      return "";
    }
  }

  function emit(payload) {
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify({
          ...payload,
          at: Date.now()
        })
      }));
    } catch (error) {
      // Observation must never affect the page.
    }
  }
})();
