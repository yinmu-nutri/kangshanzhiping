import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9334;
const PAGE_URL = 'http://127.0.0.1:8787/index.html';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangshan-dump-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank'
], { stdio: 'ignore' });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let nextId = 1;
const pending = new Map();
let loadResolvers = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  }
  if (msg.method === 'Page.loadEventFired') {
    const waiting = loadResolvers;
    loadResolvers = [];
    waiting.forEach((fn) => fn());
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitLoad() {
  return new Promise((resolve) => loadResolvers.push(resolve));
}
async function ev(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}
async function report(label) {
  await ev("document.getElementById('btn-glim-to-diet').click()");
  await sleep(300);
  await ev("document.getElementById('btn-gen-diet').click()");
  await sleep(500);
  console.log('\n========== ' + label + ' ==========');
  console.log(await ev("document.getElementById('report').innerText"));
  console.log('\n--- meal totals ---');
  console.log(await ev("document.getElementById('r-meal-total').innerText"));
}

await send('Page.enable');
await send('Runtime.enable');
const loaded = waitLoad();
await send('Page.navigate', { url: PAGE_URL });
await loaded;
await sleep(500);

await ev("document.getElementById('btn-demo-a').click()");
await sleep(800);
await report('案例 A');

await ev("document.querySelector('.nav-link[data-view=\"home\"]').click()");
await sleep(200);
await ev("document.getElementById('btn-demo-b').click()");
await sleep(900);
await report('案例 B');

ws.close();
edge.kill();
setTimeout(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}, 400);
