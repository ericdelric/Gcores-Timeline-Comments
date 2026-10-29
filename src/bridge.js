/*
 * MAIN-world bridge.
 *
 * The page already requests the radio payload (which contains the editorial
 * timeline) and the comments feed.  Reuse those responses instead of asking
 * GCORES a second time.  Data is emitted as a JSON string so it can safely
 * cross the MAIN-world / isolated-world boundary.
 */
(function installGcoresTimelineBridge() {
  'use strict';

  if (window.__GTC_BRIDGE_INSTALLED__) return;
  window.__GTC_BRIDGE_INSTALLED__ = true;

  const API_EVENT = 'gtc:api-data';
  const LOCATION_EVENT = 'gtc:location';
  const RADIO_RE = /\/gapi\/v1\/radios\/(\d+)(\/comments)?(?:[?#]|$)/;
  const captured = new Set();

  function absoluteUrl(value) {
    try {
      if (value instanceof Request) return new URL(value.url, location.href).href;
      return new URL(String(value), location.href).href;
    } catch (_error) {
      return '';
    }
  }

  function isRelevant(url) {
    return RADIO_RE.test(url);
  }

  function emit(url, data) {
    if (!data || !isRelevant(url)) return;
    // Avoid a duplicate event if both fetch and XHR wrappers see one request.
    const signature = `${url}:${data.meta && data.meta['record-count'] ? data.meta['record-count'] : ''}`;
    if (captured.has(signature)) return;
    captured.add(signature);
    if (captured.size > 40) captured.delete(captured.values().next().value);

    try {
      window.dispatchEvent(
        new CustomEvent(API_EVENT, {
          detail: JSON.stringify({ url, data }),
        })
      );
    } catch (_error) {
      // Never break the host page because a diagnostic event could not be sent.
    }
  }

  function emitLocation() {
    try {
      window.dispatchEvent(new CustomEvent(LOCATION_EVENT, { detail: location.href }));
    } catch (_error) {
      // Ignore.
    }
  }

  function wrapFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__gtcWrapped) return;
    const original = window.fetch;

    function wrappedFetch(input, init) {
      const promise = original.apply(this, arguments);
      let url = '';
      try {
        url = absoluteUrl(input);
      } catch (_error) {
        url = '';
      }

      if (url && isRelevant(url)) {
        promise
          .then((response) => {
            if (!response || !response.ok) return;
            try {
              response
                .clone()
                .json()
                .then((data) => emit(url, data))
                .catch(() => {});
            } catch (_error) {
              // Ignore opaque or already-consumed responses.
            }
          })
          .catch(() => {});
      }
      return promise;
    }

    wrappedFetch.__gtcWrapped = true;
    window.fetch = wrappedFetch;
  }

  function wrapXhr() {
    if (typeof XMLHttpRequest !== 'function' || XMLHttpRequest.prototype.__gtcWrapped) {
      return;
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(method, url) {
      this.__gtcUrl = absoluteUrl(url);
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function send() {
      if (this.__gtcUrl && isRelevant(this.__gtcUrl)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (this.responseType === '' || this.responseType === 'text') {
              const data = JSON.parse(this.responseText);
              emit(this.__gtcUrl, data);
            } else if (this.responseType === 'json' && this.response) {
              emit(this.__gtcUrl, this.response);
            }
          } catch (_error) {
            // Ignore non-JSON responses.
          }
        });
      }
      return originalSend.apply(this, arguments);
    };

    XMLHttpRequest.prototype.__gtcWrapped = true;
  }

  function wrapHistory() {
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    history.pushState = function pushState() {
      const result = originalPush.apply(this, arguments);
      setTimeout(emitLocation, 0);
      return result;
    };

    history.replaceState = function replaceState() {
      const result = originalReplace.apply(this, arguments);
      setTimeout(emitLocation, 0);
      return result;
    };
  }

  wrapFetch();
  wrapXhr();
  wrapHistory();
  window.addEventListener('popstate', emitLocation);
  window.addEventListener('hashchange', emitLocation);
})();
