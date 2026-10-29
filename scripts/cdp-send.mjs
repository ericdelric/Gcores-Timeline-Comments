/* Minimal single-command CDP caller used by the integration checks. */
const wsUrl = process.argv[2];
const method = process.argv[3];
const params = process.argv[4] ? JSON.parse(process.argv[4]) : {};

if (!wsUrl || !method) {
  console.error('usage: node scripts/cdp-send.mjs <ws-url> <method> [json-params]');
  process.exit(2);
}

const socket = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(methodName, methodParams = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method: methodName, params: methodParams }));
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

try {
  const result = await send(method, params);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
socket.close();
