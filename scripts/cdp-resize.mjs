/* Resize the Chrome window that hosts the GCORES page (real layout, not emulation). */
const port = process.argv[2] || '9337';
const width = Number(process.argv[3] || 1024);
const height = Number(process.argv[4] || 768);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && /gcores\.com\/radios\//.test(t.url));
if (!page) throw new Error('no gcores page target');
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());

const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.id });
await send('Browser.setWindowBounds', {
  windowId,
  bounds: { width, height, windowState: 'normal' },
});
console.log(JSON.stringify({ windowId, targetId: page.id, page: page.url, width, height }));
ws.close();
