/* Fail only comments requests, then verify the extension's graceful fallback. */
const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error('usage: node scripts/test-failure.mjs <page-ws-url>');
  process.exit(2);
}

const socket = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
let pausedCount = 0;

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Fetch.requestPaused') {
    pausedCount += 1;
    const { requestId, request } = message.params;
    if (/\/comments(?:\?|$)/.test(request.url)) {
      send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    } else {
      send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Fetch.enable', {
  patterns: [{ urlPattern: '*comments*', requestStage: 'Request' }],
});

const result = await send('Runtime.evaluate', {
  expression: `(async () => {
    history.pushState({ route: 'failure-test' }, '', '/radios/221487');
    dispatchEvent(new PopStateEvent('popstate'));
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const toast = document.querySelector('.gtc-toast');
    const audio = document.querySelector('#gcores-player-media');
    return {
      href: location.href,
      markers: document.querySelectorAll('.gtc-marker').length,
      toast: toast ? toast.innerText : '',
      role: toast ? toast.getAttribute('role') : '',
      retry: Boolean(toast && toast.querySelector('button')),
      audioPresent: Boolean(audio),
      paused: audio ? audio.paused : null,
    };
  })()`,
  returnByValue: true,
  awaitPromise: true,
});

await send('Fetch.disable').catch(() => {});
console.log(JSON.stringify({ pausedCount, ...result.result.value }, null, 2));
socket.close();
