import './style.css';
import { LabScene } from './scene.ts';
import { RadarView } from './radar.ts';
import { ScanHistory, TeachingTimeline, simulate, advanceScan, STEP_MS, SOUND_MM_PER_US } from './model.ts';
import type { InputMode, Preset, Sample } from './model.ts';
import { LineDecoder, encodeSample } from './protocol.ts';
import { SerialConnection } from './serial.ts';

const icons: Record<string, string> = {
  radar: '<path d="M4.2 15.8A9 9 0 1 1 20.8 9M7 13a5.5 5.5 0 1 1 10-5M10 11a2 2 0 0 1 3-2M12 12l7-7M12 12v8M4 20h16"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  link: '<path d="m9 15 6-6M7 14l-2 2a3.5 3.5 0 0 0 5 5l4-4a3.5 3.5 0 0 0 0-5M17 10l2-2a3.5 3.5 0 0 0-5-5l-4 4a3.5 3.5 0 0 0 0 5"/>',
  reset: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
  clear: '<path d="m9 4-6 9 7 7h8l4-8-8-8H9ZM7 16l9-10M10 20h12"/>',
  full: '<path d="M9 3H3v6M15 3h6v6M21 15v6h-6M3 15v6h6"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  chevron: '<path d="m8 4 8 8-8 8"/>',
  cube: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9"/>',
  book: '<path d="M12 6v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  wave: '<path d="M3 12h3l3-7 6 14 3-7h3"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.radar}</svg>`;

document.querySelector('#app')!.innerHTML = `
  <div class="page-shell">
    <header class="appbar">
      <a class="brand" href="./" aria-label="声探实验室首页"><span class="brand-symbol">${icon('radar')}</span><span>声探<span class="brand-en">SONAR LAB</span></span></a>
      <nav class="mode-tabs" aria-label="演示模式">
        <button class="mode-tab active" id="scan-mode" aria-pressed="true">${icon('radar')}<span>实时扫描</span></button>
        <button class="mode-tab" id="teach-mode" aria-pressed="false">${icon('book')}<span>分步教学</span></button>
      </nav>
      <div class="header-actions"><span class="local-badge"><i></i>本机实验室</span><button class="button outline" id="open-settings">${icon('link')}<span>连接与数据</span></button></div>
    </header>

    <main>
      <section class="intro">
        <div><div class="eyebrow">EXPLORE THE UNSEEN</div><h1>让距离，变得可见<span class="title-dot">。</span></h1><p>跟随一次扫描，读懂每一个回声。</p></div>
        <div class="scene-picker"><label for="preset">实验场景</label><div class="select-wrap">${icon('cube')}<select id="preset"><option value="mixed">方块与圆柱</option><option value="near">近距离障碍</option><option value="empty">空场景</option></select></div></div>
      </section>

      <div class="workspace">
        <section class="panel device-panel" aria-labelledby="device-title">
          <div class="panel-heading"><div class="panel-title"><span class="section-number">01</span><h2 id="device-title">扫描实验台</h2></div><span class="small-label">3D EXPLORER</span></div>
          <div class="scene-stage"><div id="scene"></div><div id="scene-fallback" hidden>三维画面暂时不可用，请启用浏览器的图形加速。雷达与教学功能仍可使用。</div><div class="stage-note"><span class="tiny-dot"></span><span id="scene-note">超声探头 · 水平往返扫描</span></div><div class="stage-scale"><span>180°<small>扫描范围</small></span><span>250<small>cm 量程</small></span></div><button class="view-reset" id="reset-view" title="复位视角" aria-label="复位视角">${icon('reset')}</button><div class="orbit-tip">拖动旋转 · 滚轮缩放</div></div>
          <div class="device-caption"><span class="caption-icon">${icon('wave')}</span><span id="device-caption">探头转向哪里，扫描就发生在哪里。</span><span class="source-tag" id="source-tag">SIM 模拟</span></div>
        </section>

        <section class="panel radar-panel" aria-labelledby="radar-title">
          <div class="panel-heading"><div class="panel-title"><span class="section-number">02</span><h2 id="radar-title">空间回声</h2></div><span class="live-badge" id="live-badge"><i></i><span id="live-label">扫描中</span></span></div>
          <div class="measurements"><div><span class="metric-label">当前测距</span><div class="distance-reading"><strong id="distance">—</strong><span>cm</span></div></div><div class="angle-metric"><span class="metric-label">探头角度</span><div><strong id="angle">90</strong><span>°</span></div></div></div>
          <div class="radar-chart"><canvas id="radar" aria-label="实时扇形雷达扫描结果"></canvas></div>
          <div class="radar-legend"><span><i class="dot green"></i>障碍回声</span><span><i class="line-key"></i>扫描轨迹</span><span class="range-label">RANGE 2.5 m</span></div>
          <div class="radar-summary"><div><span class="metric-label">本程最近</span><strong id="nearest">—<small> cm</small></strong></div><div><span class="metric-label">探测状态</span><strong class="status-text" id="measure-status">等待测量</strong></div><div><span class="metric-label">扫描轨迹</span><strong><span id="trail-count">0</span><small> / 13</small></strong></div></div>
        </section>
      </div>

      <div class="playback-toolbar"><div class="playback-actions"><button class="button primary" id="toggle-run">${icon('pause')}<span>暂停扫描</span></button><button class="button subtle" id="clear-results">${icon('clear')}<span>清空结果</span></button><span class="toolbar-divider"></span><span class="toolbar-hint" id="toolbar-hint">每次转动 3°，发现新的空间。</span></div><div class="toolbar-meta"><span id="sample-seq">#000000</span><button class="icon-button" id="fullscreen" title="全屏展示" aria-label="全屏展示">${icon('full')}</button></div></div>

      <section class="teaching-panel" aria-labelledby="teaching-title">
        <div class="teaching-heading"><div><span class="eyebrow">A JOURNEY OF SOUND</span><h2 id="teaching-title">一次测量，四个瞬间</h2></div><div class="formula"><span>距离</span><b>=</b><span>声速 × 往返时间</span><b>÷ 2</b></div></div>
        <div class="steps">
          <div class="step" data-stage="0"><div class="step-index">01</div><div><h3>转向定位</h3><p id="step-description-0">舵机带动探头，朝向目标角度。</p></div><span class="step-arrow">${icon('chevron')}</span></div>
          <div class="step" data-stage="1"><div class="step-index">02</div><div><h3>发射声波</h3><p id="step-description-1">短促的超声脉冲，向前出发。</p></div><span class="step-arrow">${icon('chevron')}</span></div>
          <div class="step" data-stage="2"><div class="step-index">03</div><div><h3 id="echo-title">接收回波</h3><p id="step-description-2">声波遇到障碍，沿途返回。</p></div><span class="step-arrow">${icon('chevron')}</span></div>
          <div class="step" data-stage="3"><div class="step-index">04</div><div><h3>更新距离</h3><p id="step-description-3">由往返时间，计算目标距离。</p></div></div>
        </div>
        <div class="teaching-controls" id="teaching-controls" hidden><label class="angle-control" for="teaching-angle">测量方向 <input id="teaching-angle" type="range" min="0" max="180" step="3" value="90"><output id="teaching-angle-value">90°</output></label><span class="slow-label">${icon('wave')}慢放示意</span><button class="button subtle" id="repeat-lesson">${icon('reset')}重新测量</button><button class="button primary" id="next-step">下一步 · 转向定位 ${icon('arrow')}</button></div>
        <div class="teaching-invitation" id="teaching-invitation"><span>想看清一次回声如何发生？</span><button id="enter-lesson">进入分步教学 ${icon('arrow')}</button></div>
      </section>
      <footer><span>声探实验室<span class="footer-separator">/</span>超声扫描雷达教学演示</span><span id="footer-note">几何场景模拟 · 声速取 343 m/s</span></footer>
    </main>
  </div>

  <dialog id="settings" aria-labelledby="settings-title"><div class="drawer-header"><div><div class="eyebrow">DATA & CONNECTION</div><h2 id="settings-title">连接与数据</h2></div><button class="icon-button" id="close-settings" aria-label="关闭连接与数据">${icon('close')}</button></div><div class="drawer-body">
    <label class="field-label" for="input-source">数据来源</label><select class="field" id="input-source"><option value="demo">内置模拟</option><option value="manual">字符串输入</option><option value="serial">浏览器串口</option></select>
    <p class="field-help" id="source-help">使用预设障碍物，实时计算扫描交点。</p>
    <section id="serial-section" hidden><div class="settings-section-heading"><h3>串口连接</h3><span class="source-tag">8N1</span></div><label class="field-label" for="baud">波特率</label><select class="field" id="baud"><option>9600</option><option>19200</option><option>38400</option><option>57600</option><option>115200</option></select><div class="serial-actions"><button class="button primary" id="connect-serial">${icon('link')}选择串口并连接</button><button class="button outline" id="disconnect-serial" disabled>断开</button></div><p class="field-help" id="serial-message" role="status">请使用桌面 Chrome；连接后等待数据。</p><p class="field-help">暂停仅冻结展示，后台继续接收。恢复时显示最新样本。</p></section>
    <section id="manual-section" hidden><h3>输入测量字符串</h3><p class="field-help">每行一笔测量；提交多行时按顺序更新轨迹。</p><label class="sr-only" for="manual-input">测量字符串</label><textarea id="manual-input" spellcheck="false" rows="6">SCAN,1,60,1400,OK,SIM\nSCAN,2,90,850,OK,SIM\nSCAN,3,120,NA,TIMEOUT,PROTEUS</textarea><button class="button primary" id="submit-manual">应用字符串 ${icon('arrow')}</button><p class="field-help" id="manual-message" role="status"></p></section>
    <details class="protocol-reference"><summary>查看数据协议 ${icon('chevron')}</summary><p>逐行 CSV · 距离单位 mm</p><code>SCAN,42,90,850,OK,SIM</code><dl><dt>42</dt><dd>序号（非负整数）</dd><dt>90</dt><dd>角度 0°～180°</dd><dt>850</dt><dd>距离 1～2500 mm；无回波用 NA</dd><dt>OK</dt><dd>OK / NO_HIT / TIMEOUT</dd><dt>SIM</dt><dd>SIM / PROTEUS / DEVICE</dd></dl><p>兼容现有固件11列CSV。0°向右，90°向前，180°向左。</p></details>
    <section class="log-section"><div class="settings-section-heading"><h3>数据日志</h3><button class="text-button" id="clear-log">清空</button></div><ol id="log" aria-label="数据日志"><li class="log-info">实验室已就绪。</li></ol></section>
  </div></dialog>
  <div id="toast" role="status" aria-live="polite"></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const history = new ScanHistory();
const teaching = new TeachingTimeline();
const decoder = new LineDecoder();
const radar = new RadarView($<HTMLCanvasElement>('radar'));
let scene: LabScene | null = null;
try { scene = new LabScene($('scene')); } catch (err) { $('scene-fallback').hidden = false; console.error(err); }
let source: InputMode = 'demo';
let preset: Preset = 'mixed';
let lesson = false;
let paused = false;
let angle = 90;
let direction: 1 | -1 = 1;
let sequence = 0;
let accumulator = 0;
let latest: Sample | null = null;
let pending: Sample | null = null;
let lessonSample = simulate(90, 0, preset);
let lessonApplied = false;
let lastExternalAt = 0;
let toastTimer = 0;

function toast(message: string): void {
  $('toast').textContent = message; $('toast').classList.add('visible');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => $('toast').classList.remove('visible'), 2800);
}
function log(message: string, kind: 'info' | 'error' | 'sample' = 'info'): void {
  const item = document.createElement('li'); item.className = `log-${kind}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  item.textContent = `${time}  ${message}`; $('log').prepend(item);
  while ($('log').children.length > 80) $('log').lastElementChild?.remove();
}
const originLabel = (sample: Sample | null) => sample?.origin === 'PROTEUS' ? 'Proteus 仿真' : sample?.origin === 'DEVICE' ? '设备数据' : 'SIM 模拟';
const cm = (mm: number | null | undefined) => mm == null ? '—' : (mm / 10).toFixed(1);

function updateMeasurements(): void {
  $('distance').textContent = cm(latest?.distanceMm);
  $('angle').textContent = String(latest?.angle ?? angle);
  $('nearest').innerHTML = `${cm(history.nearest?.distanceMm)}<small> cm</small>`;
  $('trail-count').textContent = String(history.trail.length);
  $('measure-status').textContent = latest === null ? '等待测量' : latest.status === 'OK' ? '发现障碍' : latest.status === 'TIMEOUT' ? '回波超时' : '无障碍回声';
  $('measure-status').classList.toggle('warning', latest?.status === 'TIMEOUT' || (latest?.distanceMm != null && latest.distanceMm < 500));
  $('source-tag').textContent = latest ? originLabel(latest) : source === 'demo' ? 'SIM 模拟' : '等待数据';
  $('sample-seq').textContent = `#${String(latest?.seq ?? 0).padStart(6, '0')}`;
  $('footer-note').textContent = source === 'demo' ? '几何场景模拟 · 声速取 343 m/s' : `${latest ? originLabel(latest) : '外部数据'} · 角度与距离由输入驱动`;
}
function applySample(sample: Sample): void {
  latest = sample; angle = sample.angle; history.add(sample);
  radar.update(history.trail, sample.angle); scene?.setMeasurement(sample, history.trail);
  updateMeasurements();
}
function clearResults(): void {
  history.clear(); latest = null; pending = null;
  radar.update([], angle); scene?.setMeasurement(null, []); updateMeasurements();
}
function setPaused(value: boolean): void {
  paused = value; accumulator = 0;
  if (!paused && pending && source !== 'demo') { applySample(pending); pending = null; }
  updateControls();
}
function updateControls(): void {
  const runLabel = lesson ? (paused ? '继续演示' : '暂停演示') : source !== 'demo' ? (paused ? '继续展示' : '暂停展示') : paused ? '继续扫描' : '暂停扫描';
  $('toggle-run').innerHTML = `${icon(paused ? 'play' : 'pause')}<span>${runLabel}</span>`;
  $('scan-mode').classList.toggle('active', !lesson); $('scan-mode').setAttribute('aria-pressed', String(!lesson));
  $('teach-mode').classList.toggle('active', lesson); $('teach-mode').setAttribute('aria-pressed', String(lesson));
  $('teaching-controls').hidden = !lesson; $('teaching-invitation').hidden = lesson;
  const slider = $<HTMLInputElement>('teaching-angle'); slider.disabled = teaching.stage >= 0;
  const button = $<HTMLButtonElement>('next-step');
  button.disabled = paused || teaching.animating || teaching.stage === 3;
  const names = ['转向定位', '发射声波', lessonSample.status === 'OK' ? '接收回波' : '等待超时', '更新距离'];
  button.innerHTML = teaching.stage === 3 ? `测量完成 ${icon('check')}` : teaching.animating ? '演示中…' : `下一步 · ${names[teaching.stage + 1]} ${icon('arrow')}`;
  $('toolbar-hint').textContent = lesson ? paused ? '演示已暂停，继续后接着观察。' : teaching.animating ? '慢放示意 · 观察声波的旅程。' : '点击「下一步」，逐个观察测量环节。' : source === 'demo' ? '每次转动 3°，发现新的空间。' : '外部数据驱动 · 暂停仅冻结展示。';
  updateLiveStatus();
}
function updateLiveStatus(): void {
  let label = paused ? '已暂停' : lesson ? teaching.animating ? '慢放演示' : '等待下一步' : source === 'demo' ? '扫描中' : source === 'manual' ? '字符串输入' : '等待串口';
  let inactive = paused || lesson && !teaching.animating;
  if (source === 'serial') {
    if (serial.state !== 'connected') { label = serial.state === 'connecting' ? '连接中' : '串口未连接'; inactive = true; }
    else if (Date.now() - lastExternalAt > 2000) { label = lastExternalAt ? '数据已超时' : '等待串口数据'; inactive = true; }
    else if (!paused) { label = '实时接收'; inactive = false; }
  }
  $('live-label').textContent = label; $('live-badge').classList.toggle('inactive', inactive);
}
function updateSteps(): void {
  document.querySelectorAll<HTMLElement>('.step').forEach((el, i) => {
    el.classList.toggle('current', lesson && teaching.stage === i);
    el.classList.toggle('complete', lesson && teaching.stage > i);
  });
  const hit = lessonSample.status === 'OK';
  $('echo-title').textContent = lesson && !hit ? '等待超时' : '接收回波';
  $('step-description-0').textContent = lesson ? `探头转向 ${lessonSample.angle}°，准备测量。` : '舵机带动探头，朝向目标角度。';
  $('step-description-1').textContent = '短促的超声脉冲，向前出发。';
  $('step-description-2').textContent = lesson && !hit ? '量程内无回声，等待到达超时。' : '声波遇到障碍，沿途返回。';
  $('step-description-3').textContent = lesson && teaching.stage === 3 ? hit ? `往返约 ${((lessonSample.distanceMm! * 2 / SOUND_MM_PER_US) / 1000).toFixed(2)} ms → ${cm(lessonSample.distanceMm)} cm` : '距离为 —，本次不生成命中点。' : '由往返时间，计算目标距离。';
}
function resetLesson(): void {
  teaching.reset(); lessonApplied = false;
  const value = Number($<HTMLInputElement>('teaching-angle').value);
  lessonSample = simulate(value, sequence, preset);
  clearResults(); angle = value; radar.update([], value);
  $('angle').textContent = String(value); updateSteps(); updateControls();
}
function setLesson(value: boolean): void {
  if (value && source !== 'demo') { changeSource('demo'); toast('分步教学已切换为内置模拟'); }
  lesson = value; paused = false; accumulator = 0;
  if (value) resetLesson();
  else { teaching.reset(); clearResults(); updateSteps(); updateControls(); }
  $('device-caption').textContent = value ? '慢放一次回声，看见测量的每个瞬间。' : '探头转向哪里，扫描就发生在哪里。';
}
function changeSource(value: InputMode): void {
  if (source === value) return;
  if (source === 'serial') void serial.disconnect();
  decoder.reset(); source = value; lesson = false; teaching.reset(); paused = false; lastExternalAt = 0; accumulator = 0;
  $<HTMLSelectElement>('input-source').value = value;
  $('manual-section').hidden = value !== 'manual'; $('serial-section').hidden = value !== 'serial';
  $<HTMLSelectElement>('preset').disabled = value !== 'demo';
  $('source-help').textContent = value === 'demo' ? '使用预设障碍物，实时计算扫描交点。' : value === 'manual' ? '提交字符串，即可驱动探头与扫描结果。' : '读取系统串口的逐行数据，支持虚拟 COM 口。';
  $('scene-note').textContent = value === 'demo' ? '超声探头 · 水平往返扫描' : '外部数据 · 显示测量点迹';
  $('device-caption').textContent = value === 'demo' ? '探头转向哪里，扫描就发生在哪里。' : '接收角度与距离，同步呈现测量结果。';
  scene?.setPreset(preset, value === 'demo'); clearResults(); updateSteps(); updateControls();
  log(`切换数据来源：${value === 'demo' ? '内置模拟' : value === 'manual' ? '字符串输入' : '浏览器串口'}`);
}
function receiveText(text: string): { good: number; bad: number } {
  let good = 0, bad = 0;
  for (const line of decoder.push(text)) {
    if (line.kind === 'sample') {
      good++; lastExternalAt = Date.now(); log(encodeSample(line.sample), 'sample');
      if (paused) pending = line.sample; else applySample(line.sample);
    } else if (line.kind === 'error') { bad++; log(line.text, 'error'); }
    else log(line.text);
  }
  updateLiveStatus(); return { good, bad };
}
const serial = new SerialConnection(text => { if (source === 'serial') receiveText(text); }, (state, message) => {
  $('serial-message').textContent = message;
  $<HTMLButtonElement>('connect-serial').disabled = state === 'connecting' || state === 'connected';
  $<HTMLButtonElement>('disconnect-serial').disabled = state !== 'connected' && state !== 'connecting';
  $('disconnect-serial').textContent = state === 'connecting' ? '取消等待' : '断开';
  $<HTMLSelectElement>('baud').disabled = state === 'connected' || state === 'connecting';
  if (state === 'connecting') { decoder.reset(); lastExternalAt = 0; pending = null; }
  log(message, state === 'error' ? 'error' : 'info'); updateLiveStatus();
});

$('scan-mode').addEventListener('click', () => setLesson(false));
$('teach-mode').addEventListener('click', () => setLesson(true));
$('enter-lesson').addEventListener('click', () => setLesson(true));
$('toggle-run').addEventListener('click', () => setPaused(!paused));
$('clear-results').addEventListener('click', () => { clearResults(); toast('扫描结果已清空'); });
$('reset-view').addEventListener('click', () => { scene?.resetCamera(); toast('视角已复位'); });
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('当前窗口不支持全屏，可使用浏览器全屏功能'); }
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '全屏展示');
});
$<HTMLSelectElement>('preset').addEventListener('change', e => {
  preset = (e.target as HTMLSelectElement).value as Preset;
  scene?.setPreset(preset, true); clearResults(); accumulator = 0;
  if (lesson) resetLesson();
});
$<HTMLInputElement>('teaching-angle').addEventListener('input', e => {
  const value = Number((e.target as HTMLInputElement).value);
  $('teaching-angle-value').textContent = `${value}°`; lessonSample = simulate(value, sequence, preset);
  angle = value; radar.update(history.trail, value); $('angle').textContent = String(value); updateSteps();
});
$('next-step').addEventListener('click', () => {
  if (!lesson || paused || !teaching.next()) return;
  if (teaching.stage === 0) { lessonSample = simulate(Number($<HTMLInputElement>('teaching-angle').value), sequence++, preset); scene?.setAngle(lessonSample.angle); }
  updateSteps(); updateControls();
});
$('repeat-lesson').addEventListener('click', () => { paused = false; resetLesson(); });
$<HTMLSelectElement>('input-source').addEventListener('change', e => changeSource((e.target as HTMLSelectElement).value as InputMode));
const settings = $<HTMLDialogElement>('settings');
$('open-settings').addEventListener('click', () => settings.showModal());
$('close-settings').addEventListener('click', () => settings.close());
settings.addEventListener('click', e => { if (e.target === settings && e.clientX < settings.getBoundingClientRect().left) settings.close(); });
$('submit-manual').addEventListener('click', () => {
  decoder.reset();
  const input = $<HTMLTextAreaElement>('manual-input').value;
  const { good, bad } = receiveText(input.endsWith('\n') ? input : `${input}\n`);
  $('manual-message').textContent = `已接收 ${good} 笔测量${bad ? `，${bad} 行错误，详见日志` : ''}${paused && good ? '；展示已暂停，恢复后显示最新样本' : ''}。`;
  if (!good && !bad) $('manual-message').textContent = '请输入测量字符串。';
});
$('connect-serial').addEventListener('click', () => void serial.connect(Number($<HTMLSelectElement>('baud').value)));
$('disconnect-serial').addEventListener('click', () => void serial.disconnect());
$('clear-log').addEventListener('click', () => $('log').replaceChildren());
if (!serial.supported) $('serial-message').textContent = '当前浏览器未提供 Web Serial。串口接入请使用桌面 Chrome 打开本机地址。';

scene?.setPreset(preset, true); updateMeasurements(); updateControls();
let previous = performance.now();
function frame(now: number): void {
  const dt = Math.min(now - previous, 100); previous = now;
  if (lesson) {
    const finished = teaching.tick(dt, paused);
    if (teaching.stage === 3 && finished && !lessonApplied) { applySample(lessonSample); lessonApplied = true; }
    if (finished) { updateSteps(); updateControls(); }
  } else if (source === 'demo' && !paused) {
    accumulator += dt;
    if (accumulator >= STEP_MS) {
      accumulator %= STEP_MS;
      const next = advanceScan(angle, direction); angle = next.angle; direction = next.direction;
      applySample(simulate(angle, sequence++, preset));
    }
  }
  scene?.render(dt, paused, lesson && teaching.stage >= 1 ? { stage: teaching.stage, progress: teaching.progress, sample: lessonSample } : null);
  updateLiveStatus(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
