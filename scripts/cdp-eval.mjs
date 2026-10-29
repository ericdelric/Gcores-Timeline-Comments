/* Minimal CDP evaluator used while developing the extension. */
const wsUrl = process.argv[2];
const expression = process.argv[3] || 'document.title';
const waitMs = Number(process.argv[4] || 0);

if (!wsUrl) {
  console.error('usage: node scripts/cdp-eval.mjs <ws-url> <expression> [wait-ms]');
  process.exit(2);
}

const socket = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
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
if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

const result = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
});

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.result.value, null, 2));
}
socket.close();
