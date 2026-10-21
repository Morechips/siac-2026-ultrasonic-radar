import { RANGE_MM } from './model.ts';
import type { InputMode, Origin, Sample } from './model.ts';

export type TaskId = 'distance' | 'direction' | 'no_echo';
export interface NotebookEntry {
  id: number;
  recordedAt: string;
  task: TaskId;
  prediction: string;
  sample: Sample;
  inputMode: InputMode;
}
export interface NotebookStatsGroup {
  origin: Origin;
  historical: boolean;
  inputMode: InputMode;
  total: number;
  validCount: number;
  minMm: number | null;
  maxMm: number | null;
  meanMm: number | null;
}

export const NOTEBOOK_CAPACITY = 200;
export const TASK_NAMES: Readonly<Record<TaskId, string>> = {
  distance: '近远与回声', direction: '角度与方向', no_echo: '没有可靠回声',
};
const INPUT_NAMES: Readonly<Record<InputMode, string>> = {
  demo: '内置模拟', manual: '字符串输入', serial: '浏览器串口',
};

function assertSample(sample: Sample): void {
  if (!sample || typeof sample !== 'object') throw new TypeError('没有可记录的测量样本。');
  if (!Number.isSafeInteger(sample.seq) || sample.seq < 0) throw new RangeError('样本序号须为非负安全整数。');
  if (!Number.isFinite(sample.angle) || sample.angle < 0 || sample.angle > 180) throw new RangeError('样本角度须在0°～180°之间。');
  if (!['SIM', 'PROTEUS', 'DEVICE'].includes(sample.origin)) throw new TypeError('样本来源须为SIM、PROTEUS或DEVICE。');
  if (!['OK', 'NO_HIT', 'TIMEOUT'].includes(sample.status)) throw new TypeError('样本状态无效。');
  if (sample.historical !== undefined && typeof sample.historical !== 'boolean') throw new TypeError('历史标记须为布尔值。');
  if (sample.outsideRange !== undefined && typeof sample.outsideRange !== 'boolean') throw new TypeError('超展示量程标记须为布尔值。');
  if (sample.status === 'OK') {
    if (!Number.isSafeInteger(sample.distanceMm) || sample.distanceMm! < 1 || sample.distanceMm! > RANGE_MM) {
      throw new RangeError('有效距离须为1～2500mm整数；超展示量程应先转为无可靠距离。');
    }
  } else if (sample.distanceMm !== null) {
    throw new TypeError('无命中或超时样本的距离须为空，不能填0或旧距离。');
  }
  if (sample.outsideRange === true && (sample.status !== 'NO_HIT' || sample.distanceMm !== null)) {
    throw new TypeError('超展示量程样本须为NO_HIT且距离为空。');
  }
}

const copySample = (sample: Sample): Sample => ({
  seq: sample.seq, angle: sample.angle, distanceMm: sample.distanceMm, status: sample.status, origin: sample.origin,
  ...(sample.historical !== undefined ? { historical: sample.historical } : {}),
  ...(sample.outsideRange !== undefined ? { outsideRange: sample.outsideRange } : {}),
});
const copyEntry = (entry: NotebookEntry): NotebookEntry => ({ ...entry, sample: copySample(entry.sample) });

/** Quote every CSV cell and force formula-looking text to remain text in spreadsheets. */
function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  text = text.replace(/\r\n|\r|\n/g, '\r\n');
  const leading = text.match(/^[\s\p{Cf}\u0000-\u001f\u007f-\u009f]*/u)?.[0] ?? '';
  const remaining = text.slice(leading.length);
  if (/^[=+\-@＝＋－＠]/u.test(remaining) || /[\p{Cf}\u0000-\u001f\u007f-\u009f]/u.test(leading)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** In-memory classroom records. Time is the web recording time, not the device sampling time. */
export class ExperimentNotebook {
  private saved: NotebookEntry[] = [];
  private nextId = 1;

  get entries(): readonly NotebookEntry[] { return this.saved.map(copyEntry); }

  add(task: TaskId, prediction: string, sample: Sample, inputMode: InputMode, now = new Date()): NotebookEntry {
    if (this.saved.length >= NOTEBOOK_CAPACITY) throw new RangeError('实验记录已达200条，请先导出，再清空后继续；没有丢弃已有记录。');
    if (!Object.hasOwn(TASK_NAMES, task)) throw new TypeError('实验任务无效。');
    if (typeof prediction !== 'string') throw new TypeError('预测须为文本。');
    if (!Object.hasOwn(INPUT_NAMES, inputMode)) throw new TypeError('输入方式无效。');
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('网页记录时间无效。');
    assertSample(sample);
    const entry: NotebookEntry = {
      id: this.nextId++, recordedAt: now.toISOString(), task, prediction, sample: copySample(sample), inputMode,
    };
    this.saved.push(entry);
    return copyEntry(entry);
  }

  clear(): void { this.saved = []; }

  /** Groups preserve source, historical status and input channel; unknown distances never count as zero. */
  get stats(): readonly NotebookStatsGroup[] {
    const groups = new Map<string, NotebookStatsGroup & { sumMm: number }>();
    for (const { sample, inputMode } of this.saved) {
      const historical = sample.historical === true;
      const key = `${inputMode}:${sample.origin}:${historical}`;
      let group = groups.get(key);
      if (!group) {
        group = { origin: sample.origin, historical, inputMode, total: 0, validCount: 0, minMm: null, maxMm: null, meanMm: null, sumMm: 0 };
        groups.set(key, group);
      }
      group.total++;
      if (sample.status === 'OK' && sample.distanceMm !== null) {
        group.validCount++; group.sumMm += sample.distanceMm;
        group.minMm = group.minMm === null ? sample.distanceMm : Math.min(group.minMm, sample.distanceMm);
        group.maxMm = group.maxMm === null ? sample.distanceMm : Math.max(group.maxMm, sample.distanceMm);
        group.meanMm = group.sumMm / group.validCount;
      }
    }
    return [...groups.values()].map(({ sumMm: _sumMm, ...group }) => group);
  }

  toCsv(): string {
    const rows: (string | number | null)[][] = [[
      '记录ID', '实验名称', '预测', '网页记录时间（非设备采样时间，UTC）', '输入方式', '数据来源',
      '实时/历史', '序号', '角度(°)', '距离(mm)', '状态', '超展示量程',
    ]];
    for (const entry of this.saved) {
      const sample = entry.sample;
      rows.push([
        entry.id, TASK_NAMES[entry.task], entry.prediction, entry.recordedAt, INPUT_NAMES[entry.inputMode], sample.origin,
        sample.historical === true ? '历史回放' : '实时/当前样本', sample.seq, sample.angle, sample.distanceMm,
        sample.status, sample.outsideRange === true ? '是' : '否',
      ]);
    }
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}
