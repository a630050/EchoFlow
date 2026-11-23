// Real Edge, isolated profile, simulated browser speech/translation APIs.
// No application dependencies or changes to the user's Edge profile.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'test-results');
const profile = join(output, `edge-profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(root + sep)) throw new Error('outside root');
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const edge = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let edgeLog = '';
edge.stderr.on('data', data => { edgeLog += data.toString(); });
edge.on('error', error => { edgeLog += error.message; });
let socket;
let downloadsCompleted = 0;
const errors = [];
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let port;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// The spawned msedge.exe is not the whole browser: renderer, GPU, utility and crashpad
// processes keep running (and lock the profile) after killing it. Record every process id
// through DevTools, close the browser cleanly (a hard kill leaves crash dumps), wait for all
// of them to exit, and force-kill only what remains.
async function closeEdge() {
  const pids = new Set(edge.pid ? [edge.pid] : []);
  if (port) {
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
      const browser = new WebSocket(webSocketDebuggerUrl);
      await Promise.race([once(browser, 'open'), sleep(3000)]);
      const info = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 3000);
        browser.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          if (message.id === 1) { clearTimeout(timer); resolve(message.result); }
        });
        browser.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
      });
      for (const item of info?.processInfo || []) pids.add(item.id);
      browser.send(JSON.stringify({ id: 2, method: 'Browser.close' }));
    } catch {}
  }
  for (let i = 0; i < 100 && [...pids].some(alive); i++) await sleep(100);
  for (const pid of [...pids].filter(alive)) {
    await new Promise(resolve => spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve).on('error', resolve));
  }
  if (edge.exitCode === null) edge.kill();
  // Last sweep for helpers DevTools does not list (e.g. crashpad), matched only by this run's unique profile path.
  const sweep = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:EDGE_TEST_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  await new Promise(resolve => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', sweep], { windowsHide: true, stdio: 'ignore', env: { ...process.env, EDGE_TEST_PROFILE: profile } }).on('exit', resolve).on('error', resolve));
}
// Remove this run's throwaway profile. Set KEEP_EDGE_PROFILE=1 to keep it for debugging.
async function removeProfile() {
  if (process.env.KEEP_EDGE_PROFILE === '1') return;
  try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { console.warn(`Could not remove test profile ${profile}: ${error.message}`); }
}
try {
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); }
  }
  assert.ok(port, 'Edge remote debugger started');
  console.log(`Edge debugging port: ${port}`);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') downloadsCompleted++;
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const current = ++id;
      const timeout = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      pending.set(current, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression, label) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error(`Timed out: ${label || expression}`);
  }
  // A second, unmocked tab of the app on its own DevTools connection.
  async function openPage(url) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, 'open');
    let next = 0;
    const replies = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && replies.has(message.id)) { replies.get(message.id)(message); replies.delete(message.id); }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++next;
      const timer = setTimeout(() => { replies.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      replies.set(current, message => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
    const run = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await run(expression)) return; await sleep(50); } throw new Error(`Timed out: ${label}`); };
    const close = async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {}); };
    return { run, until, close };
  }
  async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  async function screenshot(name) {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, name), Buffer.from(result.data, 'base64'));
  }
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin });
  await waitFor('document.querySelector("#record") && document.querySelector("#clear").disabled', 'initial render');
  await sleep(400);
  const capabilities = await evaluate('({ userAgent:navigator.userAgent, speech:!!(window.SpeechRecognition||window.webkitSpeechRecognition), translator:!!window.Translator, secure:window.isSecureContext })');
  if (capabilities.translator) {
    capabilities.nativeAvailability = await evaluate(`Promise.all(['en','ja','ko','zh-Hant'].map(async sourceLanguage=>{
      const targetLanguage=sourceLanguage==='zh-Hant'?'en':'zh-Hant';
      try {const state=await Promise.race([Translator.availability({sourceLanguage,targetLanguage}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),5000))]);return {sourceLanguage,targetLanguage,state};}
      catch(error){return {sourceLanguage,targetLanguage,error:error.message};}
    }))`);
  }
  await screenshot('edge-empty.png');
  console.log('Native capabilities:', JSON.stringify(capabilities));

  const mock = `
    window.__recognizers = []; window.__calls = []; window.__prepared = new Set();
    window.__dictionary = {
      'zh-Hant': {'Hello world.':'你好，世界。','Again.':'再一次。','Old tail':'舊的尾句','こんにちは。':'你好。','最後の一文':'最後一句'},
      ko: {'Hello world.':'안녕하세요, 세계.','Again.':'다시 한번.','Old tail':'이전 끝 문장','こんにちは。':'안녕하세요.','最後の一文':'마지막 문장'},
    };
    window.__audioProcessors = [];
    // Keep the real (fake-device) microphone and AudioContext for the AudioWorklet check.
    window.__realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__RealAudioContext = window.AudioContext;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable:true,value:async()=>({getTracks:()=>[{stop(){},addEventListener(){}}]})});
    class FakeAudioContext {
      constructor(){this.state='running';this.destination={};}
      createMediaStreamSource(){return {connect(){},disconnect(){}};}
      createScriptProcessor(){const processor={connect(){},disconnect(){}};window.__audioProcessors.push(processor);return processor;}
      createGain(){return {gain:{value:0},connect(){},disconnect(){}};}
      resume(){this.state='running';return Promise.resolve();}
      close(){this.state='closed';return Promise.resolve();}
    }
    Object.defineProperty(window,'AudioContext',{configurable:true,value:FakeAudioContext});
    class FakeRecognition {
      constructor() { window.__recognizers.push(this); }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
      emit(values) { this.onresult?.({results: values.map(([text,final]) => Object.assign([{transcript:text}], {isFinal:final}))}); }
    }
    Object.defineProperty(window, 'SpeechRecognition', {configurable:true, value:FakeRecognition});
    Object.defineProperty(window, 'Translator', {configurable:true, value:{
      availability: async ({sourceLanguage, targetLanguage}) => window.__prepared.has(sourceLanguage+'->'+targetLanguage) ? 'available' : 'downloadable',
      create(options) {
        window.__calls.push({type:'create',active:navigator.userActivation.isActive,source:options.sourceLanguage,target:options.targetLanguage});
        if (window.__denyDownload && !window.__prepared.has(options.sourceLanguage+'->'+options.targetLanguage)) return Promise.reject(new DOMException('下載被拒絕','NotAllowedError'));
        window.__prepared.add(options.sourceLanguage+'->'+options.targetLanguage);
        options.monitor?.({ addEventListener(type,fn) { fn({loaded:1,total:1}); } });
        // Realistic output without language prefixes; unknown text passes through unchanged.
        return Promise.resolve({translate:async(text) => {window.__calls.push({type:'translate',text,source:options.sourceLanguage,target:options.targetLanguage});if (window.__failTranslate) throw new Error('模擬翻譯失敗');return window.__dictionary[options.targetLanguage]?.[text] ?? text;}, destroy(){}});
      }
    }});
    Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text=>{window.__clipboard=text}}});
  `;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mock });
  await send('Page.reload');
  await waitFor('document.querySelector("#record") && !document.querySelector("#record").disabled');
  await check('defaults and Windows Edge recommendation', async () => {
    assert.deepEqual(await evaluate('[document.querySelector("#source-language").value,document.querySelector("#target-language").value,document.querySelector("#display-mode").value]'), ['en', 'zh-TW', 'both']);
    assert.equal(await evaluate('document.querySelector("#browser-warning").open'), false);
  });
  await check('start auto-prepares the pair in the click; interim visible, final paragraphs and failed model preparation', async () => {
    await waitFor('document.querySelector("#package-list").textContent.includes("尚待下載")', 'current pair availability checked at startup');
    await evaluate('window.__denyDownload=true;document.querySelector("#record").click();__recognizers[0].emit([["Hello",false]])');
    assert.deepEqual(await evaluate('__calls.filter(c=>c.type==="create").map(c=>[c.source,c.target,c.active])'), [['en', 'zh-Hant', true]]);
    await waitFor('document.querySelector("#notice").textContent.includes("翻譯包準備失敗")', 'auto-prepare failure notice');
    assert.deepEqual(await evaluate('[document.querySelector("#notice").getAttribute("role"),document.querySelector("#notice").getAttribute("aria-live")]'), ['alert', 'assertive']);
    assert.equal(await evaluate('document.querySelector("#interim").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#interim .translation").textContent'), '（原文辨識中）');
    await evaluate('__recognizers[0].emit([["Hello world.",true],["Again.",true]])');
    await waitFor('document.querySelectorAll("#segments .error:not([hidden])").length===2');
    assert.equal(await evaluate('document.querySelectorAll("#segments .segment").length'), 2);
  });
  await check('model preparation retains user activation and retries failed segments', async () => {
    await evaluate('window.__denyDownload=false;document.querySelector("#settings-open").click()');
    await waitFor('!document.querySelector("#check-packages").disabled');
    // Real input event from CDP, not just DOM click.
    const rect = await evaluate('(()=>{const b=document.querySelector("#prepare");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
    await waitFor('document.querySelector("#translation-status").textContent==="翻譯已完成"');
    assert.equal(await evaluate('__calls.filter(c=>c.type==="create").at(-1).active'), true);
  });
  await check('font, colors and size sliders apply behind dialog immediately', async () => {
    await evaluate('document.querySelector("#source-size").value=30;document.querySelector("#source-size").dispatchEvent(new Event("input"));document.querySelector("#translation-size").value=25;document.querySelector("#translation-size").dispatchEvent(new Event("input"));document.querySelector("#translation-color").value="#bb4477";document.querySelector("#translation-color").dispatchEvent(new Event("input"));document.querySelector("#source-font").value="kai";document.querySelector("#source-font").dispatchEvent(new Event("input"))');
    assert.deepEqual(await evaluate('[getComputedStyle(document.querySelector("#segments .source")).fontSize,getComputedStyle(document.querySelector("#segments .translation")).fontSize,getComputedStyle(document.querySelector("#segments .translation")).color]'), ['30px', '25px', 'rgb(187, 68, 119)']);
    assert.match(await evaluate('getComputedStyle(document.querySelector("#segments .source")).fontFamily'), /DFKai/);
    // Line spacing: tighter default, adjustable for both source and translation.
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#segments .source")).lineHeight'), '48px', 'default 1.6 × 30px');
    await evaluate('document.querySelector("#line-height").value=1.3;document.querySelector("#line-height").dispatchEvent(new Event("input"))');
    assert.deepEqual(await evaluate('[getComputedStyle(document.querySelector("#segments .source")).lineHeight,getComputedStyle(document.querySelector("#segments .translation")).lineHeight,document.querySelector("#line-height-output").value]'), ['39px', '32.5px', '1.30 倍']);
    await screenshot('edge-appearance.png');
    await evaluate('document.querySelector("#settings-close").click()');
  });
  await check('licence text opens inside the page although LICENSE is served as a download', async () => {
    await evaluate('document.querySelector("#settings-open").click();document.querySelector("#license-link").click()');
    await waitFor('document.querySelector("#license-dialog").open', 'licence dialog');
    assert.match(await evaluate('document.querySelector("#license-text").textContent'), /MIT License/);
    await evaluate('document.querySelector("#license-close").click();document.querySelector("#settings-close").click()');
  });
  await check('live source/target switching preserves existing paragraphs and tail', async () => {
    await evaluate('__recognizers[0].emit([["Hello world.",true],["Again.",true],["Old tail",false]]);document.querySelector("#source-language").value="ja";document.querySelector("#source-language").dispatchEvent(new Event("change"))');
    await waitFor('__recognizers.length===2');
    assert.equal(await evaluate('__recognizers[1].lang'), 'ja-JP');
    await evaluate('document.querySelector("#target-language").value="ko";document.querySelector("#target-language").dispatchEvent(new Event("change"));__recognizers[1].emit([["こんにちは。",true],["最後の一文",false]]);document.querySelector("#record").click()');
    await waitFor('document.querySelectorAll("#segments .segment").length===5');
    assert.equal(await evaluate('document.querySelector("#segments .translation").textContent'), '你好，世界。');
    assert.equal(await evaluate('document.querySelectorAll("#segments .segment-label").length'), 0, 'no per-paragraph language label');
    await evaluate('__recognizers[0].emit([["late event",true]])');
    assert.equal(await evaluate('document.querySelectorAll("#segments .segment").length'), 5);
  });
  await check('all display modes and copying only visible landed text', async () => {
    for (const mode of ['source', 'translation', 'both']) {
      await evaluate(`document.querySelector('#display-mode').value='${mode}';document.querySelector('#display-mode').dispatchEvent(new Event('change'));document.querySelector('#copy').click()`);
      const copied = await evaluate('__clipboard');
      assert.equal(copied.includes('翻譯失敗'), false); assert.equal(copied.includes('辨識中'), false);
      if (mode === 'source') { assert.match(copied, /こんにちは/); assert.equal(copied.includes('你好，世界'), false); }
      if (mode === 'translation') {
        const translations = await evaluate('[...Object.values(__dictionary["zh-Hant"]),...Object.values(__dictionary.ko)]');
        assert.match(copied, /你好，世界。/);
        assert.ok(copied.split('\n\n').every(line => translations.includes(line)), copied);
      }
    }
  });
  await check('full translation uses paragraph source and current target', async () => {
    await evaluate('document.querySelector("#settings-open").click()');
    await waitFor('!document.querySelector("#check-packages").disabled');
    await evaluate('document.querySelector("#prepare").click()');
    await waitFor('!document.querySelector("#prepare").disabled');
    await evaluate('document.querySelector("#package-source").value="en";document.querySelector("#package-source").dispatchEvent(new Event("change"));document.querySelector("#prepare").click()');
    await waitFor('!document.querySelector("#prepare").disabled');
    await evaluate('document.querySelector("#settings-close").click();document.querySelector("#retranslate").click()');
    await waitFor('!document.querySelector("#retranslate").disabled');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .segment")].every(n=>n.querySelector(".translation").textContent===__dictionary.ko[n.querySelector(".source").textContent])'), true);
    assert.ok(await evaluate('__calls.some(c=>c.type==="translate"&&c.source==="ja"&&c.target==="ko")'));
    await screenshot('edge-transcript.png');
  });
  await check('TXT download uses BOM and current display mode', async () => {
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
    const isExport = name => name.startsWith('聽譯流_') && name.endsWith('.txt');
    const existing = new Set((await readdir(output)).filter(isExport));
    const completedBefore = downloadsCompleted;
    await evaluate('document.querySelector("#export").click()');
    // Read and delete only after Edge finalizes the download, or it re-creates an empty file.
    for (let i = 0; i < 100 && downloadsCompleted === completedBefore; i++) await sleep(50);
    assert.ok(downloadsCompleted > completedBefore, 'TXT download completed');
    let file;
    // Only a file created by this run counts; an older export must not satisfy the check.
    for (let i = 0; i < 100; i++) { file = (await readdir(output)).find(name => isExport(name) && !existing.has(name)); if (file) break; await sleep(50); }
    assert.ok(file, 'new TXT export downloaded'); const bytes = await readFile(join(output, file));
    await rm(join(output, file), { force: true });
    assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    assert.match(bytes.toString('utf8'), /こんにちは。\n안녕하세요\./);
  });
  await check('IndexedDB restores transcript and typography without opening microphone', async () => {
    await sleep(300); await send('Page.reload');
    await waitFor('document.querySelectorAll("#segments .segment").length===5');
    assert.equal(await evaluate('__recognizers.length'), 0);
    assert.equal(await evaluate('document.querySelector("#source-language").value'), 'ja');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#segments .source")).fontSize'), '30px');
    assert.equal(await evaluate('document.querySelector("#translation-color").value'), '#bb4477');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#segments .source")).lineHeight'), '39px', 'line spacing persists');
  });
  await check('dark theme, mobile layout, whole-page scroll and sticky controls', async () => {
    await evaluate('document.querySelector("#author").click()');
    assert.equal(await evaluate('document.body.dataset.theme'), 'dark');
    // The light-theme custom colour (#bb4477) must not carry over; dark uses its own default.
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#segments .translation")).color'), 'rgb(158, 191, 228)');
    await screenshot('edge-dark.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    await screenshot('edge-mobile.png');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#transcript")).overflowY'), 'visible');
    // Make the page clearly taller than the screen, so the top is far from the bottom.
    await evaluate('document.querySelector("#record").click();__recognizers[0].emit(Array.from({length:12},(_,i)=>["Filler paragraph "+i,true]))');
    await sleep(100);
    await evaluate('window.scrollTo(0,0)');
    await sleep(100);
    await evaluate('__recognizers[0].emit([...Array.from({length:12},(_,i)=>["Filler paragraph "+i,true]),["new content",true]])');
    assert.equal(await evaluate('window.scrollY'), 0);
    assert.equal(await evaluate('Math.round(document.querySelector(".masthead").getBoundingClientRect().top)'), 0);
    await evaluate('document.querySelector("#record").click()');
  });
  await check('force bottom can be escaped by up button and one-third threshold pauses following', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const buttons = () => evaluate('[!document.querySelector("#scroll-top").hidden,!document.querySelector("#scroll-bottom").hidden]');
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit(Array.from({length:30},(_,i)=>["Paragraph "+i,true]))');
    await sleep(200);
    assert.equal(await evaluate('document.documentElement.scrollHeight-window.scrollY-innerHeight<5'), true);
    assert.deepEqual(await buttons(), [true, false], 'following at the bottom: only "to top"');
    await evaluate('window.scrollTo(0,document.documentElement.scrollHeight-innerHeight-innerHeight/3-30)');
    await sleep(100);
    const pausedAt = await evaluate('window.scrollY');
    await evaluate('__recognizers.at(-1).emit([...Array.from({length:30},(_,i)=>["Paragraph "+i,true]),["extra",true]])');
    assert.equal(await evaluate('window.scrollY'), pausedAt);
    assert.deepEqual(await buttons(), [true, true], 'reading older text: both buttons');
    await evaluate('document.querySelector("#force-bottom").checked=true;document.querySelector("#force-bottom").dispatchEvent(new Event("change"));window.scrollTo(0,0)');
    await sleep(100);
    assert.equal(await evaluate('document.documentElement.scrollHeight-window.scrollY-innerHeight<5'), true);
    assert.deepEqual(await buttons(), [true, false], 'forced to the bottom: only "to top"');
    await evaluate('document.querySelector("#scroll-top").click()');
    await sleep(100);
    assert.equal(await evaluate('document.querySelector("#force-bottom").checked'), false);
    assert.equal(await evaluate('window.scrollY'), 0);
    await evaluate('__recognizers.at(-1).emit([...Array.from({length:30},(_,i)=>["Paragraph "+i,true]),["extra",true],["after up",false]])');
    assert.equal(await evaluate('window.scrollY'), 0);
    assert.deepEqual(await buttons(), [false, true], 'at the top: only "to bottom"');
    await screenshot('edge-sticky-toolbar.png');
    await evaluate('document.querySelector("#scroll-bottom").click()');
    await sleep(100);
    assert.equal(await evaluate('document.documentElement.scrollHeight-window.scrollY-innerHeight<5'), true, '"to bottom" jumps to the latest text');
    assert.deepEqual(await buttons(), [true, false], 'back to following: only "to top"');
    await evaluate('__recognizers.at(-1).emit([...Array.from({length:30},(_,i)=>["Paragraph "+i,true]),["extra",true],["after up",true],["following again",true]])');
    assert.equal(await evaluate('document.documentElement.scrollHeight-window.scrollY-innerHeight<5'), true, 'and keeps following new text');
    await evaluate('document.querySelector("#record").click()');
  });
  await check('F9 forces a fresh recognizer and commits interim exactly once', async () => {
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["F9 tail",false]])');
    const before = await evaluate('__recognizers.length');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 });
    await waitFor(`__recognizers.length===${before + 1}`);
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="F9 tail").length'), 1);
    await evaluate('document.querySelector("#record").click()');
  });
  await check('F8 retries failed paragraphs; the status bar reminds users of F8 and F9', async () => {
    assert.match(await evaluate('document.querySelector(".shortcut-hint").textContent'), /F8 重試翻譯 · F9 重啟辨識/);
    assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".shortcut-hint")).display'), 'none');
    await evaluate('window.__failTranslate=true;document.querySelector("#record").click();__recognizers.at(-1).emit([["F8 retry me",true]])');
    await waitFor('document.querySelector("#translation-status").textContent.includes("待重試")', 'failed paragraph');
    await evaluate('window.__failTranslate=false;document.querySelector("#record").click()');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 });
    await waitFor('document.querySelector("#translation-status").textContent==="翻譯已完成"', 'F8 retry translated the paragraph');
    assert.match(await evaluate('document.querySelector("#notice").textContent'), /1 段.*（F8）/);
    assert.deepEqual(await evaluate('[document.querySelector("#notice").getAttribute("role"),document.querySelector("#notice").getAttribute("aria-live")]'), ['status', 'polite']);
  });
  await check('translation dropdown shows one panel; the custom API translates with the saved URL, token and prompt', async () => {
    // Intercept only the fake endpoint; nothing reaches a real service.
    await evaluate(`{window.__apiCalls=[];const realFetch=window.fetch;window.fetch=async(url,init)=>{
      if(!String(url).startsWith('https://llm.example/'))return realFetch(url,init);
      const body=JSON.parse(init.body);__apiCalls.push({url:String(url),headers:init.headers,credentials:init.credentials,body});
      return new Response(JSON.stringify({choices:[{message:{content:'API譯文：'+body.messages[1].content}}]}),{status:200,headers:{'Content-Type':'application/json'}});}}`);
    await evaluate('document.querySelector("#settings-open").click()');
    assert.deepEqual(await evaluate('[document.querySelector("#translation-method").value,document.querySelector("#panel-offline").hidden,document.querySelector("#panel-api").hidden,document.querySelector("#panel-offline h4").textContent]'), ['offline', false, true, '瀏覽器離線翻譯包']);
    await evaluate('{const m=document.querySelector("#translation-method");m.value="api";m.dispatchEvent(new Event("change"))}');
    assert.deepEqual(await evaluate('[document.querySelector("#panel-offline").hidden,document.querySelector("#panel-api").hidden]'), [true, false]);
    assert.match(await evaluate('document.querySelector("#panel-api .warning-box").textContent'), /只保存在這台電腦.*公用.*清除 Token/s);
    assert.equal(await evaluate('document.querySelector("#api-token").type'), 'password');
    await evaluate(`for(const [id,v] of [["api-url","https://llm.example/v1/chat/completions"],["api-model","test-model"],["api-token","sk-smoke"],["api-prompt","請把{source}翻成{target}"]]){const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event("input"));}`);
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("echoflow.translation")).token'), 'sk-smoke');
    assert.equal(await evaluate('localStorage.getItem("echoflow.preferences").includes("sk-smoke")'), false, 'token kept apart from other preferences');
    await evaluate('document.querySelector("#api-test").click()');
    await waitFor('document.querySelector("#api-message").textContent.includes("連線成功")', 'API test succeeded');
    await evaluate('document.querySelector("#settings-close").click();document.querySelector("#record").click();__recognizers.at(-1).emit([["api sentence",true]]);document.querySelector("#record").click()');
    await waitFor('[...document.querySelectorAll("#segments .translation")].some(n=>n.textContent==="API譯文：api sentence")', 'paragraph translated by the custom API');
    const call = await evaluate('__apiCalls.at(-1)');
    assert.equal(call.headers.Authorization, 'Bearer sk-smoke');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.body.model, 'test-model');
    assert.equal(call.body.messages[0].content, '請把日文翻成韓文');
    // Back to the offline packages; the token can be cleared on its own.
    await evaluate('document.querySelector("#settings-open").click();document.querySelector("#api-clear-token").click();{const m=document.querySelector("#translation-method");m.value="offline";m.dispatchEvent(new Event("change"))}');
    assert.deepEqual(await evaluate('[JSON.parse(localStorage.getItem("echoflow.translation")).token,document.querySelector("#panel-offline").hidden]'), ['', false]);
    await evaluate('document.querySelector("#settings-close").click()');
  });
  await check('five seconds of synthetic sound without progress restarts recognition end to end', async () => {
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["watchdog tail",false]])');
    await waitFor('__audioProcessors.at(-1)?.onaudioprocess');
    const before = await evaluate('__recognizers.length');
    await evaluate(`(async()=>{
      for(let i=0;i<55;i++){
        await new Promise(resolve=>setTimeout(resolve,100));
        __audioProcessors.at(-1).onaudioprocess?.({inputBuffer:{sampleRate:1000,getChannelData:()=>new Float32Array(100).fill(i<5?.0001:.2)}});
      }
    })()`);
    await waitFor(`__recognizers.length===${before + 1}`);
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="watchdog tail").length'), 1);
    await evaluate('document.querySelector("#record").click()');
  });
  await check('closing the page keeps the sentence still being recognised', async () => {
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["closing tail",false]])');
    await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="closing tail").length'), 1);
    assert.equal(await evaluate('__recognizers.length'), 0, 'reload does not reopen the microphone');
    // The paragraph reached the transcript, so its draft is dropped and nothing is offered.
    assert.equal(await evaluate('document.querySelector("#draft-banner").hidden'), true);
    assert.deepEqual(await evaluate('[localStorage.getItem("echoflow.draft"),localStorage.getItem("echoflow.draft.recover")]'), [null, null]);
  });
  await check('a tail whose close-time write did not finish is restored automatically from its draft', async () => {
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["auto tail",false]])');
    // The close-time transcript write fails (as when the page is torn down first); the draft names the paragraph.
    await evaluate('IDBObjectStore.prototype.put=function(){throw new DOMException("simulated loss","AbortError")}');
    await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    await waitFor('[...document.querySelectorAll("#segments .source")].some(n=>n.textContent==="auto tail")', 'tail restored');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="auto tail").length'), 1);
    assert.equal(await evaluate('document.querySelector("#draft-banner").hidden'), true, 'no question asked for a known tail');
    assert.match(await evaluate('document.querySelector("#notice").textContent'), /已恢復上次關閉前/);
    await sleep(400); await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="auto tail").length'), 1, 'saved once, not restored twice');
  });
  await check('a periodic draft from a tab killed mid-sentence is offered back to restore or discard', async () => {
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["draft in progress",false]])');
    await waitFor('JSON.parse(localStorage.getItem("echoflow.draft")||"null")?.text==="draft in progress"', 'periodic draft while recognising');
    // Simulate the tab being killed: nothing the page tries while closing reaches storage.
    await evaluate('IDBObjectStore.prototype.put=function(){throw new DOMException("simulated loss","AbortError")};Storage.prototype.setItem=function(){};Storage.prototype.removeItem=function(){}');
    await send('Page.reload');
    await waitFor('document.querySelector("#draft-banner")&&!document.querySelector("#draft-banner").hidden', 'recovery offered');
    assert.match(await evaluate('document.querySelector("#draft-text").textContent'), /1 句.*draft in progress/);
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].some(n=>n.textContent==="draft in progress")'), false);
    await evaluate('document.querySelector("#draft-restore").click()');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="draft in progress").length'), 1);
    assert.equal(await evaluate('document.querySelector("#draft-banner").hidden'), true);
    await sleep(400); await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('[...document.querySelectorAll("#segments .source")].filter(n=>n.textContent==="draft in progress").length'), 1);
    assert.equal(await evaluate('document.querySelector("#draft-banner").hidden'), true);
    assert.deepEqual(await evaluate('[localStorage.getItem("echoflow.draft"),localStorage.getItem("echoflow.draft.recover")]'), [null, null]);
  });
  await check('volume sensor measures a real microphone stream through AudioWorklet', async () => {
    const result = await evaluate(`(async () => {
      const { VoiceSensor } = await import(location.origin + '/voice-watchdog.js');
      let frames = 0;
      const sensor = new VoiceSensor({ onFrame: () => frames++, getUserMedia: constraints => __realGetUserMedia(constraints), createContext: () => new __RealAudioContext() });
      await sensor.start();
      await new Promise(resolve => setTimeout(resolve, 1500));
      const worklet = sensor.processor instanceof AudioWorkletNode;
      const state = sensor.context && sensor.context.state;
      sensor.stop();
      return { frames, worklet, state };
    })()`);
    assert.equal(result.worklet, true, JSON.stringify(result));
    assert.ok(result.frames >= 10, JSON.stringify(result));
  });
  await check('clear removes persisted transcript while keeping preferences', async () => {
    await evaluate('document.querySelector("#clear").click();document.querySelector("#clear-confirm").click()');
    await waitFor('document.querySelectorAll("#segments .segment").length===0');
    await sleep(300); await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('document.querySelectorAll("#segments .segment").length'), 0);
    assert.equal(await evaluate('document.body.dataset.theme'), 'dark');
  });
  const sourcesIn = run => run('[...document.querySelectorAll("#segments .source")].map(n=>n.textContent)');
  const storedSources = `new Promise((resolve, reject) => { const request = indexedDB.open('echoflow'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const get = request.result.transaction('documents').objectStore('documents').get('current');
      get.onsuccess = () => { request.result.close(); resolve((get.result || []).map(s => s.sourceText)); }; }; })`;
  await check('hand-off: the editing tab saves its recognising tail and confirms the write before the new tab reads', async () => {
    // Recording, with a fresh final still inside the save debounce and a sentence still being recognised.
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["handoff final",true],["handoff tail",false]])');
    const second = await openPage(origin);
    try {
      await second.until('document.querySelector("#tab-banner") && !document.querySelector("#tab-banner").hidden', 'second tab read-only banner');
      assert.equal(await second.run('document.querySelector("#record").disabled'), true);
      assert.equal(await evaluate('document.querySelector("#tab-banner").hidden'), true);
      await second.run('document.querySelector("#tab-takeover").click()');
      await second.until('document.querySelector("#tab-banner").hidden', 'second tab took over');
      const taken = await sourcesIn(second.run);
      assert.ok(taken.includes('handoff final') && taken.includes('handoff tail'), JSON.stringify(taken));
      await waitFor('!document.querySelector("#tab-banner").hidden', 'first tab handed off');
      assert.equal(await evaluate('document.querySelector("#record").disabled'), true);
      assert.match(await evaluate('document.querySelector("#speech-status").textContent'), /準備就緒/);
    } finally { await second.close(); }
    await evaluate('document.querySelector("#tab-takeover").click()');
    await waitFor('document.querySelector("#tab-banner").hidden', 'first tab took back over');
    assert.equal(await evaluate('document.querySelector("#record").disabled'), false);
    assert.equal((await sourcesIn(evaluate)).filter(text => text === 'handoff tail').length, 1);
  });
  await check('an unresponsive editing tab is taken over by force and its delayed save cannot overwrite', async () => {
    await send('Debugger.enable');
    await evaluate('document.querySelector("#record").click();__recognizers.at(-1).emit([["frozen final",true]]);document.querySelector("#record").click()');
    await send('Debugger.pause'); // Freezes this tab before its 300 ms save timer can run.
    const second = await openPage(origin);
    try {
      await second.until('document.querySelector("#tab-banner") && !document.querySelector("#tab-banner").hidden', 'second tab read-only banner');
      await second.run('document.querySelector("#tab-takeover").click()');
      await second.until('document.querySelector("#tab-banner").hidden', 'forced take-over after the hand-off timeout', 200);
      await sleep(500); // Let the new editing tab write its copy.
      await send('Debugger.resume'); // The frozen tab wakes with its stale save still scheduled.
      await waitFor('!document.querySelector("#tab-banner").hidden', 'woken tab stops editing');
      await sleep(500);
      const stored = await second.run(storedSources);
      assert.equal(stored.includes('frozen final'), false, JSON.stringify(stored));
      assert.ok(stored.includes('handoff tail'), JSON.stringify(stored));
    } finally { await send('Debugger.disable').catch(() => {}); await second.close(); }
    await evaluate('document.querySelector("#tab-takeover").click()');
    await waitFor('document.querySelector("#tab-banner").hidden', 'first tab took back over');
  });
  await check('unreadable saved transcript pauses saving and offers a raw backup before discarding', async () => {
    await evaluate(`new Promise((resolve, reject) => { const request = indexedDB.open('echoflow', 1); request.onerror = () => reject(request.error);
      request.onsuccess = () => { const tx = request.result.transaction('documents', 'readwrite'); tx.objectStore('documents').put([{ id: 7, broken: true }], 'current');
        tx.oncomplete = () => { request.result.close(); resolve(true); }; tx.onerror = () => reject(tx.error); }; })`);
    await send('Page.reload');
    await waitFor('document.querySelector("#recovery") && !document.querySelector("#recovery").hidden', 'recovery offered');
    assert.equal(await evaluate('document.querySelector("#discard-raw").disabled'), true);
    const existing = new Set(await readdir(output));
    const completedBefore = downloadsCompleted;
    await evaluate('document.querySelector("#export-raw").click()');
    for (let i = 0; i < 100 && downloadsCompleted === completedBefore; i++) await sleep(50);
    const file = (await readdir(output)).find(name => name.endsWith('_原始備份.json') && !existing.has(name));
    assert.ok(file, 'raw backup downloaded');
    const backup = JSON.parse(await readFile(join(output, file), 'utf8'));
    await rm(join(output, file), { force: true });
    assert.deepEqual(backup, [{ id: 7, broken: true }]);
    await evaluate('document.querySelector("#discard-raw").click()');
    await sleep(300); await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('document.querySelector("#recovery").hidden'), true);
  });
  await check('first non-Windows Edge visit warns once', async () => {
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140 Safari/537.36' });
    await send('Page.reload');
    await waitFor('document.querySelector("#browser-warning")?.open');
    await evaluate('document.querySelector("#browser-ack").click()');
    await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.equal(await evaluate('document.querySelector("#browser-warning").open'), false);
  });
  await check('storage unavailable keeps transcription usable and displays backup notice', async () => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
      Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError')}});
    ` });
    await send('Page.reload');
    await waitFor('document.querySelector("#record")&&!document.querySelector("#record").disabled');
    assert.match(await evaluate('document.querySelector(".paper-footnote").textContent'), /本機保存目前不可用/);
    await evaluate('document.querySelector("#browser-ack").click();document.querySelector("#record").click();__recognizers[0].emit([["still works",true]])');
    assert.equal(await evaluate('document.querySelector("#segments .source").textContent'), 'still works');
  });
  assert.deepEqual(errors, [], 'no uncaught browser exceptions');
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ capabilities, checks, exceptions: errors, actualMicrophoneTested: false, actualModelsDownloaded: false }, null, 2));
  console.log(`\n${checks.length} browser checks passed. Screenshots/report: ${output}`);
} finally {
  await writeFile(join(output, 'edge-launch.log'), edgeLog);
  socket?.close();
  await closeEdge();
  server.close();
  await removeProfile();
}
