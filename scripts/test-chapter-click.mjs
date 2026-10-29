/* Physical-mouse check that the official chapter labels still seek. */
const ws = new WebSocket(process.argv[2]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');

const find = await send('Runtime.evaluate', {
  expression: `(() => {
    const wanted = ${JSON.stringify(process.argv[3] || '')};
    const anchor = [...document.querySelectorAll(
      '.playerFullscreenTimelineProgress_timeline'
    )].find((node) => {
      const title = node.querySelector('.playerFullscreenTimelineProgress_timelineTitle');
      const rect = (title || node).getBoundingClientRect();
      const visible = rect.x > 0 && rect.right < innerWidth - 350 && rect.width > 20;
      return visible && title && (!wanted || title.innerText.includes(wanted));
    });
    if (!anchor) return null;
    const title = anchor.querySelector('.playerFullscreenTimelineProgress_timelineTitle');
    const rect = (title || anchor).getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      hit: hit ? hit.tagName + '.' + hit.className : null,
      paused: document.querySelector('#gcores-player-media')?.paused,
      time: document.querySelector('#gcores-player-media')?.currentTime,
    };
  })()`,
  returnByValue: true,
});
const point = find.result.result.value;
if (!point) {
  console.log(JSON.stringify({ error: 'visible Gadio News chapter not found' }));
  process.exit(1);
}

await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: point.x,
  y: point.y,
});
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: point.x,
  y: point.y,
  button: 'left',
  clickCount: 1,
});
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: point.x,
  y: point.y,
  button: 'left',
  clickCount: 1,
});
await wait(900);

const after = await send('Runtime.evaluate', {
  expression: `(() => {
    const audio = document.querySelector('#gcores-player-media');
    return { paused: audio?.paused, time: audio?.currentTime };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify({ point, after: after.result.result.value }, null, 2));
ws.close();
