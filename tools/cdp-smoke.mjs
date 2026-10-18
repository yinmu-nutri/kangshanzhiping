import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const PAGE_URL = 'http://127.0.0.1:8787/index.html';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangshan-cdp-'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank'
], { stdio: 'ignore' });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP target not available');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const exceptions = [];
const errorLogs = [];
const requests = [];
let loadResolvers = [];

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.id) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }

  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push((d.exception && d.exception.description) || d.text || 'unknown exception');
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errorLogs.push(msg.params.entry.text);
  }
  if (msg.method === 'Network.requestWillBeSent') {
    requests.push(msg.params.request.url);
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

function waitLoad(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('page load timeout')), timeout);
    loadResolvers.push(() => { clearTimeout(timer); resolve(); });
  });
}

async function ev(expression, awaitPromise = false) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluate exception');
  }
  return res.result.value;
}

async function text(selector) {
  return ev(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

const loaded = waitLoad();
await send('Page.navigate', { url: PAGE_URL });
await loaded;
await sleep(600);

check('页面加载', await ev('document.readyState') === 'complete');
check('单文件无外链脚本', await ev("document.querySelectorAll('script[src]').length === 0"));
check('无外部样式表', await ev("document.querySelectorAll('link[rel=stylesheet]').length === 0"));

/* ---------------- 案例 A ---------------- */
await ev("document.getElementById('btn-demo-a').click()");
await sleep(900);

check('A：MNA 总分 5', (await text('#mna-result-score')).trim() === '5', await text('#mna-result-score'));
check('A：筛查等级营养不良', (await text('#mna-result-title')).includes('营养不良'));
check('A：GLIM 阳性', (await ev("document.getElementById('glim-conclusion').className")).includes('positive'), await ev("document.getElementById('glim-conclusion').className"));
check('A：GLIM 结论含符合标准', (await text('#glim-conclusion')).includes('符合 GLIM'));
check('A：GLIM 表含小腿围', (await text('#glim-criteria')).includes('小腿围'));
check('A：无 JS 异常', exceptions.length === 0, exceptions.join(' | '));

await ev("document.getElementById('btn-glim-to-diet').click()");
await sleep(350);
check('A：报告参数已带入', (await text('#diet-ref')).includes('MNA-SF'));
await ev("document.getElementById('btn-gen-diet').click()");
await sleep(500);

check('A：报告可见', await ev("getComputedStyle(document.getElementById('report-wrap')).display !== 'none'"));
check('A：姓名正确', (await text('#r-name')).includes('王秀兰'));
check('A：报告含 5/14', (await text('#r-screening')).includes('5 / 14'));
check('A：报告含 GLIM 阳性', (await text('#r-glim')).includes('符合 GLIM'));
check('A：报告含蛋白目标', (await text('#r-targets')).includes('1.2~1.5'));
check('A：报告含每餐亮氨酸', (await text('#r-meals')).includes('亮氨酸'));
check('A：报告含警示', (await text('#r-warnings')).length > 5);
check('A：演示标记可见', await ev("getComputedStyle(document.getElementById('r-demo-badge')).display !== 'none'"));

/* ---------------- 案例 B ---------------- */
await ev("document.querySelector('.nav-link[data-view=\"home\"]').click()");
await sleep(200);
await ev("document.getElementById('btn-demo-b').click()");
await sleep(1000);

check('B：MNA 总分 13', (await text('#mna-result-score')).trim() === '13', await text('#mna-result-score'));
check('B：筛查等级正常', (await text('#mna-result-title')).includes('正常'));
check('B：GLIM 仍为阳性', (await ev("document.getElementById('glim-conclusion').className")).includes('positive'));
check('B：识别肥胖型营养不良', (await text('#glim-conclusion')).includes('肥胖型营养不良'));
check('B：小腿围 33 触发', (await text('#glim-criteria')).includes('33 cm'));

await ev("document.getElementById('btn-glim-to-diet').click()");
await sleep(350);
await ev("document.getElementById('btn-gen-diet').click()");
await sleep(500);

check('B：报告含保护性区间警示', (await text('#r-warnings')).includes('保护性区间'));
check('B：报告含肌少性肥胖', (await text('#r-warnings')).includes('肌少性肥胖'));
check('B：报告含肥胖型提示', (await text('#r-glim')).includes('肥胖型'));

/* ---------------- 术后应激 ---------------- */
await ev("document.querySelector('.nav-link[data-view=\"calc\"]').click()");
await sleep(200);
await ev("document.getElementById('calc-pop-post').click()");
await sleep(200);
check('术后表单显示', await ev("getComputedStyle(document.getElementById('form-post')).display !== 'none'"));

await ev(`
  (function(){
    function set(id,v){var el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
    set('p-sex','male'); set('p-age',60); set('p-height',170); set('p-weight',65); set('p-days',10); set('p-diet','liquid');
    var none=document.getElementById('st-none'); none.checked=false; none.dispatchEvent(new Event('change',{bubbles:true}));
    var fever=document.getElementById('st-fever'); fever.checked=true; fever.dispatchEvent(new Event('change',{bubbles:true}));
    set('p-temp',38.5);
    var surg=document.getElementById('st-surgery'); surg.checked=true; surg.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('[data-calc="post"]').click();
  })()
`);
await sleep(500);

const pEnergy = await text('#p-energy');
const pNote = await text('#p-note');
check('术后能量含 1950~2340', pEnergy.includes('1950~2340'), pEnergy);
check('术后蛋白 104~130', (await text('#p-protein')).includes('104~130'), await text('#p-protein'));
check('应激取最高系数', pNote.includes('最高系数') && pNote.includes('1.2'), pNote);
check('术后第 10 天提示', pNote.includes('术后第 10 天'));
check('流质≥7 天提示 ONS', pNote.includes('ONS'));

await ev("document.querySelector('[data-diet-from=\"post\"]').click()");
await sleep(350);
await ev("document.getElementById('btn-gen-diet').click()");
await sleep(500);
check('术后报告含应激因素', (await text('#r-targets')).includes('应激因素'));
check('术后报告含最高系数', (await text('#r-targets')).includes('最高系数'));
check('术后报告含术后天数', (await text('#r-case')).includes('术后天数'));

/* ---------------- 打印 ---------------- */
await send('Emulation.setEmulatedMedia', { media: 'print' });
await sleep(200);
check('打印隐藏导航', await ev("getComputedStyle(document.querySelector('.nav-bar')).display === 'none'"));
check('打印隐藏控件', await ev("getComputedStyle(document.getElementById('diet-controls')).display === 'none'"));
check('打印显示报告视图', await ev("getComputedStyle(document.getElementById('view-diet')).display !== 'none'"));
const pdf = await send('Page.printToPDF', { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 });
check('生成有效 PDF', pdf.data && pdf.data.length > 5000, String(pdf.data ? pdf.data.length : 0));
await send('Emulation.setEmulatedMedia', { media: 'screen' });

/* ---------------- 移动端 ---------------- */
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await sleep(300);
const scrollWidth = await ev('document.documentElement.scrollWidth');
check('375px 无横向溢出', scrollWidth <= 376, 'scrollWidth=' + scrollWidth);

/* ---------------- 网络 / 错误 ---------------- */
const external = [...new Set(requests)].filter((u) =>
  !u.startsWith('http://127.0.0.1:8787/') &&
  !u.startsWith('data:') &&
  !u.startsWith('about:') &&
  !u.startsWith('edge://') &&
  !u.startsWith('devtools://')
);
check('零外部网络请求', external.length === 0, external.join(' | '));
check('全程无 JS 异常', exceptions.length === 0, exceptions.join(' | '));
check('无控制台 error', errorLogs.length === 0, errorLogs.join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} PASS =====`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach((f) => console.log('- ' + f.name + (f.detail ? ' — ' + f.detail : '')));
}

ws.close();
edge.kill();
setTimeout(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
}, 500);
