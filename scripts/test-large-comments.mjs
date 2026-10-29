/*
 * Development-only check: make the filtered “时刻” comments endpoint return
 * 350 synthetic timestamped comments (four pages) and verify the extension
 * renders all of them. This exercises the pagination path that a real
 * programme with >300 timed comments would use.
 *
 * usage: node scripts/test-large-comments.mjs <debugger-ws-url> [page-url]
 */
const wsUrl = process.argv[2];
const pageUrl = process.argv[3] || 'https://www.gcores.com/radios/221016/timelines?pi=1';
if (!wsUrl) {
  console.error('usage: node scripts/test-large-comments.mjs <debugger-ws-url> [page-url]');
  process.exit(2);
}

const TOTAL = 350;
const PAGE_SIZE = 100;

const socket = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const offsets = [];

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syntheticPage(offset) {
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - offset));
  const data = [];
  const included = [];
  for (let i = 0; i < count; i += 1) {
    const index = offset + i;
    const at = 5 + index * 17;
    const userId = `mock-user-${index}`;
    data.push({
      id: `mock-comment-${index}`,
      type: 'comments',
      attributes: {
        body: `测试评论 ${index}：这是第 ${index + 1} 条带时间戳评论。`,
        'radio-timestamp': at,
        'created-at': '2026-10-30T00:00:00+08:00',
      },
      relationships: {
        user: { data: { id: userId, type: 'users' } },
      },
    });
    included.push({
      id: userId,
      type: 'users',
      attributes: { nickname: `测试用户${index % 17}` },
    });
  }
  return {
    data,
    included,
    meta: { 'record-count': TOTAL },
  };
}

socket.addEventListener('message', async (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }

  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  let url;
  try {
    url = new URL(request.url);
  } catch (_error) {
    await send('Fetch.continueRequest', { requestId });
    return;
  }

  if (!url.pathname.endsWith('/comments') || url.searchParams.get('filter[timed]') !== '1') {
    await send('Fetch.continueRequest', { requestId });
    return;
  }

  const offset = Number(url.searchParams.get('page[offset]') || 0);
  offsets.push(offset);
  const body = Buffer.from(JSON.stringify(syntheticPage(offset))).toString('base64');
  await send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/vnd.api+json; charset=utf-8' },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
    ],
    body,
  });
});

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluation failed');
  }
  return result.result.value;
}

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Page.enable');
await send('Fetch.enable', {
  patterns: [{ urlPattern: '*comments*', requestStage: 'Request' }],
});
await send('Page.navigate', { url: pageUrl });

let total = 0;
for (let i = 0; i < 80; i += 1) {
  await wait(500);
  total = await evaluate(
    "document.querySelectorAll('.gtc-marker').length ? [...document.querySelectorAll('.gtc-marker')].reduce((n, b) => n + (Number(b.dataset.gtcCount) || 1), 0) : 0"
  );
  if (total >= TOTAL) break;
}

const info = await evaluate(`(() => {
  const marker = document.querySelector('.gtc-marker');
  return {
    href: location.href,
    markers: document.querySelectorAll('.gtc-marker').length,
    markerParent: marker ? marker.parentElement.parentElement.className : '',
    toast: document.querySelector('.gtc-toast')?.innerText || '',
  };
})()`);

console.log(JSON.stringify({ total, offsets: [...new Set(offsets)].sort((a, b) => a - b), ...info }, null, 2));
await send('Fetch.disable');
socket.close();
process.exit(total === TOTAL ? 0 : 1);
