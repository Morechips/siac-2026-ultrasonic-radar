import './classroom.css';
import type { InputMode, Origin, Sample } from './model.ts';
import { ExperimentNotebook, NOTEBOOK_CAPACITY } from './notebook.ts';
import type { NotebookEntry, TaskId } from './notebook.ts';

export interface ClassroomSnapshot {
  sample: Sample | null;
  inputMode: InputMode;
  unavailableReason?: string;
}

export interface ClassroomOptions {
  getSnapshot: () => ClassroomSnapshot;
  notify: (message: string) => void;
}

const TASKS: Record<TaskId, { title: string; question: string; instruction: string; insight: string }> = {
  distance: {
    title: '近远与回声',
    question: '目标远一点，回声回来得更快还是更慢？',
    instruction: '先看一次分步教学，再记录不同距离的数据，比较回声往返时间。',
    insight: '声音先去、再回。往返路程除以2，才是目标距离。',
  },
  direction: {
    title: '角度与方向',
    question: '距离相同的两个目标，一定在同一个位置吗？',
    instruction: '记录同距离、不同角度的数据，指出哪些在左边、前方和右边。',
    insight: '距离和方向一起描述位置：0°向右，90°向前，180°向左。',
  },
  no_echo: {
    title: '没有可靠回声',
    question: '没有测到可靠距离，就能放心向前走吗？',
    instruction: '记录一次超时或无可靠量程内测量，再和有效读数比较。',
    insight: '“—”表示没有可靠距离。历史点迹也不能当作此刻的障碍情况。',
  },
};
const TASK_IDS: TaskId[] = ['distance', 'direction', 'no_echo'];
const MODE_LABELS: Record<InputMode, string> = { demo: '内置模拟', manual: '字符串输入', serial: '浏览器串口' };
const ORIGIN_LABELS: Record<Origin, string> = { SIM: 'SIM 教学模拟', PROTEUS: 'PROTEUS 电路仿真', DEVICE: 'DEVICE 设备输入' };
let mountSequence = 0;

const centimetres = (mm: number | null) => mm === null ? '—' : (mm / 10).toFixed(1);
const statusLabel = (sample: Sample) => sample.status === 'OK' ? '有效读数'
  : sample.status === 'TIMEOUT' ? '回波超时' : '无可靠量程内测量';
const setText = (element: HTMLElement, value: string) => {
  if (element.textContent !== value) element.textContent = value;
};

/** A session-only classroom notebook. Capturing never changes the sensor or transport. */
export function mountClassroom(container: HTMLElement, options: ClassroomOptions): { refresh: () => void } {
  const prefix = `classroom-${++mountSequence}`;
  const notebook = new ExperimentNotebook();
  const predictions: Record<TaskId, string> = { distance: '', direction: '', no_echo: '' };
  let task: TaskId = 'distance';
  let total = 0;
  let confirmingClear = false;

  container.innerHTML = `
    <section class="classroom-panel" aria-labelledby="${prefix}-title">
      <div class="classroom-heading">
        <div><span class="eyebrow">OBSERVE · RECORD · EXPLAIN</span><h2 id="${prefix}-title">我的实验记录台</h2></div>
        <span class="classroom-count" data-part="count">已记录 0 笔</span>
      </div>
      <div class="classroom-grid">
        <div class="classroom-task">
          <div class="classroom-task-picker" role="group" aria-label="选择课堂实验">
            ${TASK_IDS.map((id, index) => `<button type="button" class="classroom-task-button${index === 0 ? ' active' : ''}" data-task="${id}" aria-pressed="${index === 0}"><span>0${index + 1}</span>${TASKS[id].title}</button>`).join('')}
          </div>
          <h3 data-part="question"></h3>
          <p class="classroom-instruction" data-part="instruction"></p>
          <label class="classroom-field-label" for="${prefix}-prediction">先猜一猜 <span>选填</span></label>
          <textarea id="${prefix}-prediction" class="classroom-prediction" data-part="prediction" maxlength="240" rows="2" placeholder="我觉得……" aria-describedby="${prefix}-prediction-help"></textarea>
          <p class="classroom-input-help" id="${prefix}-prediction-help">写下预测，记录后再和观察结果比较。最多240字。</p>
          <p class="classroom-insight" data-part="insight"></p>
        </div>
        <div class="classroom-capture" data-part="capture">
          <div class="classroom-capture-heading"><span>准备记录的一笔</span><span class="classroom-sample-kind" data-part="kind">等待测量</span></div>
          <div class="classroom-preview"><strong data-part="distance">—</strong><span>cm</span><span class="classroom-preview-angle" data-part="angle">—°</span></div>
          <p class="classroom-preview-status" data-part="status">等待测量</p>
          <p class="classroom-provenance" data-part="provenance">等待数据来源</p>
          <p class="classroom-history-note" data-part="history-note" hidden>这是一笔历史回放，可用于比较，不能判断此刻的障碍。</p>
          <button type="button" class="button primary classroom-record" data-part="record" disabled aria-describedby="${prefix}-availability">记录当前测量</button>
          <p class="classroom-availability" data-part="availability" id="${prefix}-availability">等待一笔可记录的测量。</p>
          <p class="classroom-input-help">每次点击只保存一笔。记录时间是网页点击时刻，非设备采样时刻。</p>
        </div>
      </div>
      <div class="classroom-records-heading">
        <div><h3>观察记录</h3><p data-part="records-summary">还没有记录，先做一个预测吧。</p></div>
        <div class="classroom-record-actions"><button type="button" class="button outline" data-part="export" disabled>导出 CSV</button><button type="button" class="button subtle" data-part="clear" disabled aria-expanded="false" aria-controls="${prefix}-clear">清空记录</button></div>
      </div>
      <div class="classroom-clear-confirm" id="${prefix}-clear" data-part="clear-confirm" hidden role="group" aria-label="确认清空实验记录">
        <span data-part="clear-question"></span><div><button type="button" class="button outline" data-part="cancel-clear">保留记录</button><button type="button" class="button classroom-danger" data-part="confirm-clear">确认清空</button></div>
      </div>
      <p class="classroom-local-note">本页最多保存${NOTEBOOK_CAPACITY}笔；刷新页面会丢失，离开前请导出。表内显示最近8笔。</p>
      <div class="classroom-table-scroll" role="region" aria-label="最近实验记录，可横向滚动" tabindex="0">
        <table class="classroom-table"><caption class="sr-only">最近8笔实验记录，按记录时间由新到旧排列</caption><thead><tr><th scope="col">记录时间</th><th scope="col">实验</th><th scope="col">方向</th><th scope="col">距离/cm</th><th scope="col">测量结果</th><th scope="col">输入方式与来源</th><th scope="col">预测</th></tr></thead><tbody data-part="rows"></tbody></table>
      </div>
      <details class="classroom-stats" data-part="stats"><summary>分组比较 <span data-part="stats-count">0 组</span></summary><p>只统计有效距离。输入方式、声明来源、实时与历史分别计算，不合并成一个平均数。</p><div class="classroom-table-scroll" role="region" aria-label="按输入方式、来源和实时或历史分组的统计，可横向滚动" tabindex="0"><table class="classroom-table classroom-stats-table"><caption class="sr-only">当前会话全部记录的分组统计</caption><thead><tr><th scope="col">输入方式</th><th scope="col">声明来源</th><th scope="col">类别</th><th scope="col">记录/有效</th><th scope="col">平均/cm</th><th scope="col">最小/cm</th><th scope="col">最大/cm</th></tr></thead><tbody data-part="stats-rows"></tbody></table></div></details>
      <p class="classroom-boundary">SIM是教学模拟，PROTEUS是电路仿真，DEVICE是设备输入；来源由输入声明，需同时看输入方式。“实时”表示非历史输入。Proteus的SETPOINT给出受控距离，不随舵机角度自动计算空间声场。</p>
      <p class="classroom-feedback" data-part="feedback" role="status" aria-live="polite" aria-atomic="true"></p>
    </section>`;

  const part = <T extends HTMLElement = HTMLElement>(name: string): T => {
    const element = container.querySelector<T>(`[data-part="${name}"]`);
    if (!element) throw new Error(`Missing classroom element: ${name}`);
    return element;
  };
  const prediction = part<HTMLTextAreaElement>('prediction');
  const recordButton = part<HTMLButtonElement>('record');
  const clearButton = part<HTMLButtonElement>('clear');
  const cancelClearButton = part<HTMLButtonElement>('cancel-clear');
  const confirmClearButton = part<HTMLButtonElement>('confirm-clear');
  const exportButton = part<HTMLButtonElement>('export');

  function feedback(message: string): void {
    setText(part('feedback'), message);
    options.notify(message);
  }

  function readSnapshot(): ClassroomSnapshot {
    try { return options.getSnapshot(); }
    catch { return { sample: null, inputMode: 'demo', unavailableReason: '暂时无法读取测量，请稍后重试。' }; }
  }

  function unavailable(snapshot: ClassroomSnapshot): string {
    if (snapshot.unavailableReason) return snapshot.unavailableReason;
    if (!snapshot.sample) return '等待一笔可记录的测量。';
    if (total >= NOTEBOOK_CAPACITY) return `已记录${NOTEBOOK_CAPACITY}笔，请先导出，再清空记录。`;
    return '';
  }

  function refresh(): void {
    const snapshot = readSnapshot();
    const sample = snapshot.sample;
    const reason = unavailable(snapshot);
    const historical = sample?.historical === true;
    setText(part('distance'), centimetres(sample?.distanceMm ?? null));
    setText(part('angle'), sample ? `${sample.angle}°` : '—°');
    setText(part('status'), sample ? statusLabel(sample) : '等待测量');
    setText(part('kind'), sample ? historical ? '历史回放' : '实时输入' : '等待测量');
    part('kind').classList.toggle('historical', historical);
    setText(part('provenance'), sample ? `${MODE_LABELS[snapshot.inputMode]} · ${ORIGIN_LABELS[sample.origin]}` : '等待数据来源');
    part('history-note').hidden = !historical;
    recordButton.disabled = Boolean(reason);
    setText(part('availability'), reason || (historical ? '可记录这笔历史数据，保存后保留历史标记。' : '可记录这笔输入，来源标记会一并保存。'));
    part('capture').classList.toggle('unavailable', Boolean(reason));
  }

  function updateTask(): void {
    const content = TASKS[task];
    setText(part('question'), content.question);
    setText(part('instruction'), content.instruction);
    setText(part('insight'), content.insight);
    prediction.value = predictions[task];
    container.querySelectorAll<HTMLButtonElement>('[data-task]').forEach(button => {
      const active = button.dataset.task === task;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setClearConfirmation(value: boolean): void {
    confirmingClear = value && total > 0;
    part('clear-confirm').hidden = !confirmingClear;
    clearButton.setAttribute('aria-expanded', String(confirmingClear));
    if (confirmingClear) setText(part('clear-question'), `清空本页全部 ${total} 笔记录？请先确认已导出。`);
  }

  function textCell(value: string, className = ''): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (className) cell.className = className;
    return cell;
  }

  function entryRow(entry: NotebookEntry): HTMLTableRowElement {
    const row = document.createElement('tr');
    const time = textCell(new Date(entry.recordedAt).toLocaleTimeString('zh-CN', { hour12: false }));
    time.title = `网页记录时间，非设备采样时间：${entry.recordedAt}`;
    const provenance = document.createElement('td');
    const kind = document.createElement('span');
    kind.className = `classroom-entry-kind${entry.sample.historical ? ' historical' : ''}`;
    kind.textContent = entry.sample.historical ? '历史回放' : '实时输入';
    const source = document.createElement('span');
    source.className = 'classroom-entry-source';
    source.textContent = `${MODE_LABELS[entry.inputMode]} · ${ORIGIN_LABELS[entry.sample.origin]}`;
    provenance.append(kind, source);
    row.append(time, textCell(TASKS[entry.task].title), textCell(`${entry.sample.angle}°`),
      textCell(centimetres(entry.sample.distanceMm)), textCell(statusLabel(entry.sample)), provenance,
      textCell(entry.prediction || '未填写', 'classroom-prediction-cell'));
    return row;
  }

  function emptyRow(message: string, columns: number): HTMLTableRowElement {
    const row = document.createElement('tr');
    const cell = textCell(message, 'classroom-empty'); cell.colSpan = columns; row.append(cell);
    return row;
  }

  function updateRecords(): void {
    const entries = notebook.entries;
    total = entries.length;
    setText(part('count'), `已记录 ${total} 笔`);
    setText(part('records-summary'), total ? `共 ${total} 笔，以下按新到旧显示最近 ${Math.min(total, 8)} 笔。` : '还没有记录，先做一个预测吧。');
    part('rows').replaceChildren(...(total ? entries.slice(-8).reverse().map(entryRow) : [emptyRow('选择实验，记录第一笔观察。', 7)]));
    const groups = notebook.stats;
    const statsRows = groups.map(group => {
      const row = document.createElement('tr');
      row.append(textCell(MODE_LABELS[group.inputMode]), textCell(ORIGIN_LABELS[group.origin]),
        textCell(group.historical ? '历史' : '实时', group.historical ? 'classroom-historical-cell' : ''),
        textCell(`${group.total} / ${group.validCount}`), textCell(centimetres(group.meanMm)),
        textCell(centimetres(group.minMm)), textCell(centimetres(group.maxMm)));
      return row;
    });
    part('stats-rows').replaceChildren(...(statsRows.length ? statsRows : [emptyRow('记录后显示分组统计。', 7)]));
    setText(part('stats-count'), `${groups.length} 组`);
    clearButton.disabled = total === 0; exportButton.disabled = total === 0;
    if (!total) setClearConfirmation(false);
    refresh();
  }

  container.querySelectorAll<HTMLButtonElement>('[data-task]').forEach(button => {
    button.addEventListener('click', () => {
      task = button.dataset.task as TaskId;
      setClearConfirmation(false); updateTask();
    });
  });
  prediction.addEventListener('input', () => { predictions[task] = prediction.value; });
  recordButton.addEventListener('click', () => {
    const snapshot = readSnapshot();
    const reason = unavailable(snapshot);
    if (reason || !snapshot.sample) { feedback(reason || '还没有可记录的测量。'); refresh(); return; }
    try {
      const entry = notebook.add(task, prediction.value, snapshot.sample, snapshot.inputMode);
      setClearConfirmation(false); updateRecords();
      feedback(`已记录第 ${total} 笔：${TASKS[task].title}${entry.sample.historical ? '，历史回放数据' : ''}。`);
    } catch (error) {
      feedback(error instanceof Error ? error.message : '这笔数据不能记录，请检查测量状态。');
      refresh();
    }
  });
  clearButton.addEventListener('click', () => {
    setClearConfirmation(!confirmingClear);
    if (confirmingClear) cancelClearButton.focus();
  });
  cancelClearButton.addEventListener('click', () => { setClearConfirmation(false); clearButton.focus(); });
  confirmClearButton.addEventListener('click', () => {
    if (!confirmingClear) return;
    notebook.clear(); setClearConfirmation(false); updateRecords();
    feedback('本页实验记录已清空。');
    prediction.focus();
  });
  exportButton.addEventListener('click', () => {
    if (!total) return;
    const csv = notebook.toCsv();
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `声探实验记录_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.hidden = true; container.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback(`已生成 ${total} 笔记录的CSV，请确认文件已保存。`);
  });

  updateTask(); updateRecords();
  return { refresh };
}
