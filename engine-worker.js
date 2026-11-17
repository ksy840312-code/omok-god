/* Omok rating app – engine worker
 * © 2026 제작: 인제고 수학 교사 김수영
* Binary data files use the .wasm extension only because the host serves that type; they are raw bytes.
 * Wraps the Rapfi engine (GPL-3.0, https://github.com/dhbloo/rapfi) compiled to WebAssembly.
 * All engine calls are synchronous inside this worker, so the page never freezes.
 */
const FILES = {
  'rapfi-single-simd128.wasm': 'rapfi-single-simd128.wasm',
  'rapfi-single-simd128.data': 'rapfi-data.wasm',
};
const WEIGHTS = {
  freestyle: [['mix9svqfreestyle_bsmix.bin.lz4', 'w-freestyle.wasm']],
  renju: [
    ['mix9svqrenju_bs15_black.bin.lz4', 'w-renju-black.wasm'],
    ['mix9svqrenju_bs15_white.bin.lz4', 'w-renju-white.wasm'],
  ],
};

let M = null;
// 한 번 받은 엔진·신경망 파일은 기기(IndexedDB)에 저장해 두고 다음부터는 바로 씁니다.
const CACHE_DB = 'omok-god-cache', CACHE_VER = 'v1';
function idbOpen() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
    const r = indexedDB.open(CACHE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try { const db = await idbOpen(); return await new Promise(res => { const q = db.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  catch (e) { return null; }
}
async function idbPut(key, buf) {
  try { const db = await idbOpen(); await new Promise(res => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(buf, key); t.oncomplete = res; t.onerror = res; t.onabort = res; }); }
  catch (e) {}
}
async function cachedFetch(url, name, onProgress) {
  const key = CACHE_VER + '|' + name;
  const hit = await idbGet(key);
  if (hit && hit.byteLength) { const b = new Uint8Array(hit); onProgress(b.length, b.length, true); return b; }
  const b = await fetchWithProgress(url, (g, t) => onProgress(g, t, false));
  await idbPut(key, b.buffer.slice(0));
  return b;
}
let out = [];

function post(type, data) { self.postMessage(Object.assign({ type }, data)); }

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('파일을 불러오지 못했습니다: ' + url + ' (' + res.status + ')');
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) { const b = new Uint8Array(await res.arrayBuffer()); onProgress(b.length, b.length); return b; }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onProgress(got, total);
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

function send(cmd) { out.length = 0; M.sendCommand(cmd); return out.slice(); }

function boardCmd(head, moves) {
  // Gomocup BOARD: x,y,who  (who 1 = side to move, 2 = opponent)
  const n = moves.length;
  const lines = moves.map((m, i) => `${m[0]},${m[1]},${(i % 2) === (n % 2) ? 1 : 2}`);
  return [head].concat(lines, ['DONE']).join('\n');
}

function parseSearch(lines) {
  let move = null, winrate = null, evalv = null, depth = null, pv = null;
  for (const l of lines) {
    let m;
    if ((m = /^INFO WINRATE ([\d.eE+-]+)/.exec(l))) winrate = parseFloat(m[1]);
    else if ((m = /^INFO EVAL (-?\d+)/.exec(l))) evalv = parseInt(m[1], 10);
    else if ((m = /^INFO DEPTH (\d+)/.exec(l))) depth = parseInt(m[1], 10);
    else if ((m = /^INFO BESTLINE (.*)$/.exec(l))) pv = m[1].trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(a => a.length === 2 && !isNaN(a[0]) && !isNaN(a[1]));
    else if ((m = /^(\d+),(\d+)$/.exec(l.trim()))) move = [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return { move, winrate, eval: evalv, depth, pv };
}

async function init(rule) {
  const base = self.location.href.replace(/[^/]*$/, '');
  const urls = [FILES['rapfi-single-simd128.wasm'], FILES['rapfi-single-simd128.data']].concat(WEIGHTS[rule].map(w => w[1]));
  const sizes = {}, loaded = {}, cached = {};
  const report = () => {
    const t = Object.values(sizes).reduce((a, b) => a + b, 0);
    const g = Object.values(loaded).reduce((a, b) => a + b, 0);
    post('progress', { loaded: g, total: t, parts: urls.length, done: Object.keys(sizes).length, cached: Object.keys(cached).length === urls.length });
  };
  const bufs = await Promise.all(urls.map(u => cachedFetch(base + u, u, (g, t, c) => { loaded[u] = g; sizes[u] = t; if (c) cached[u] = 1; report(); })));
  const wasmBinary = bufs[0], dataBuf = bufs[1];

  importScripts(base + 'rapfi-single-simd128.js');
  M = await self.Rapfi({
    wasmBinary,
    getPreloadedPackage: () => dataBuf.buffer,
    locateFile: p => base + (FILES[p] || p),
    onReceiveStdout: o => out.push(o),
    onReceiveStderr: o => out.push('ERR ' + o),
  });

  // Weights + config tailored to the chosen rule
  WEIGHTS[rule].forEach((w, i) => M.FS.writeFile('/' + w[0], bufs[2 + i]));
  let cfg = new TextDecoder().decode(M.FS.readFile('/config.toml'));
  cfg = cfg.replace(/coord_conversion_mode\s*=\s*"[^"]*"/, 'coord_conversion_mode = "none"');
  const wblock = rule === 'freestyle'
    ? '[[model.evaluator.weights]]\nweight_file = "mix9svqfreestyle_bsmix.bin.lz4"\n'
    : '[[model.evaluator.weights]]\nweight_file_black = "mix9svqrenju_bs15_black.bin.lz4"\nweight_file_white = "mix9svqrenju_bs15_white.bin.lz4"\n';
  cfg = cfg.replace(/(\[\[model\.evaluator\.weights\]\][^\[]*)+/, wblock + '\n');
  M.FS.writeFile('/config.toml', cfg);

  out.length = 0;
  const rc = M._rapfiInit();
  if (rc !== 0) throw new Error('엔진 초기화 실패: ' + out.join(' / '));
  send('START 15');
  send('INFO RULE ' + (rule === 'renju' ? 4 : 0));
  send('INFO SHOW_DETAIL 2');
  send('INFO TIMEOUT_MATCH 100000000');
  send('INFO TIME_LEFT 100000000');
  send('INFO MAX_MEMORY 268435456');
  // Warm-up search so the network gets loaded now, not on the first move
  const t0 = performance.now();
  send('INFO MAX_NODE 20000'); send('INFO TIMEOUT_TURN 3000');
  send(boardCmd('BOARD', [[7, 7]]));
  const warm = performance.now() - t0;
  return { warmMs: Math.round(warm) };
}

function search({ moves, strength = 100, nodes = 0, timeMs = 1000 }) {
  send('INFO STRENGTH ' + strength);
  send('INFO MAX_NODE ' + (nodes || 0));
  send('INFO TIMEOUT_TURN ' + timeMs);
  const t0 = performance.now();
  const r = parseSearch(send(boardCmd('BOARD', moves)));
  r.ms = Math.round(performance.now() - t0);
  return r;
}

function forbid({ moves }) {
  send(boardCmd('YXBOARD', moves));
  const lines = send('YXSHOWFORBID');
  const line = lines.find(l => l.startsWith('FORBID')) || 'FORBID .';
  const digits = line.slice(7).replace('.', '').trim();
  const pts = [];
  for (let i = 0; i + 3 < digits.length; i += 4) pts.push([+digits.slice(i, i + 2), +digits.slice(i + 2, i + 4)]);
  return { points: pts };
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    let result;
    if (cmd === 'init') result = await init(args.rule);
    else if (cmd === 'search') result = search(args);
    else if (cmd === 'forbid') result = forbid(args);
    else throw new Error('unknown cmd ' + cmd);
    post('result', { id, result });
  } catch (err) {
    post('error', { id, message: String(err && err.message || err) });
  }
};
