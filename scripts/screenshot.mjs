/* Capture README screenshots from a page with the extension loaded. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error('usage: node scripts/screenshot.mjs <page-ws-url>');
  process.exit(2);
}

const socket = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Page.enable');

let metrics = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const markers = [...document.querySelectorAll('.gtc-marker')];
      if (markers.length < 3) return null;
      const visible = markers
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.right > 0 && rect.left < innerWidth)
        .sort((a, b) => a.rect.left - b.rect.left);
      const chosen = (visible[Math.floor(visible.length / 2)] || visible[0] || { element: markers[0] }).element;
      chosen.focus();
      const slider = document.querySelector('[role="slider"][aria-label*="进度"]');
      const marker = chosen.getBoundingClientRect();
      const timeline = slider ? slider.getBoundingClientRect() : null;
      return {
        innerWidth,
        innerHeight,
        markerCount: markers.length,
        marker: [marker.x, marker.y, marker.width, marker.height],
        slider: timeline ? [timeline.x, timeline.y, timeline.width, timeline.height] : null,
      };
    })()`,
    returnByValue: true,
    userGesture: true,
  });
  metrics = result.result.value;
  if (metrics) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!metrics) {
  console.error('markers did not appear');
  process.exitCode = 1;
  socket.close();
} else {
  await new Promise((resolve) => setTimeout(resolve, 500));

  const full = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });

  const top = Math.max(0, Math.floor(metrics.marker[1] - 220));
  const height = Math.min(Math.ceil(metrics.innerHeight - top), 380);
  const closeup = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: 0,
      y: top,
      width: Math.ceil(metrics.innerWidth),
      height,
      scale: 1,
    },
  });

  const fullPath = resolve('docs/screenshot.png');
  const closeupPath = resolve('docs/player-closeup.png');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, Buffer.from(full.data, 'base64'));
  await writeFile(closeupPath, Buffer.from(closeup.data, 'base64'));
  console.log(JSON.stringify({ ...metrics, fullPath, closeupPath }, null, 2));
  socket.close();
}
