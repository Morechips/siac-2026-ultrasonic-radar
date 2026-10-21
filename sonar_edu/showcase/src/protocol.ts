import { RANGE_MM } from './model.ts';
import type { Origin, Sample, Status } from './model.ts';

export type ParsedLine = { kind: 'sample'; sample: Sample } | { kind: 'replay'; action: 'start' | 'end' | 'error'; text: string } | { kind: 'log'; text: string } | { kind: 'error'; text: string; measurement?: 'live' | 'replay' };
const ORIGINS = ['SIM', 'PROTEUS', 'DEVICE'];
const STATUSES = ['OK', 'NO_HIT', 'TIMEOUT'];
const DIAGNOSTICS = /^(BOOT|BUS|OLED|ERR|SRC|STATUS|INFO|WARN|BTN)(,|$)/;
const uint = (s: string) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s));
const measurementKind = (line: string): 'live' | 'replay' | undefined => /^LOG(,|$)/.test(line.trim()) ? 'replay'
  : /^(SCAN|SIM|SRF|REAL|PROTEUS|DEVICE)(,|$)/.test(line.trim()) ? 'live' : undefined;

export function parseLine(line: string): ParsedLine {
  const text = line.trim();
  if (text === 'INFO,REPLAY_START') return { kind: 'replay', action: 'start', text };
  if (text === 'INFO,REPLAY_END') return { kind: 'replay', action: 'end', text };
  if (/^INFO,REPLAY_ERR(,|$)/.test(text)) return { kind: 'replay', action: 'error', text };
  if (!text || DIAGNOSTICS.test(text)) return { kind: 'log', text };
  const fields = text.split(',').map(s => s.trim());
  const fail = (message: string): ParsedLine => ({ kind: 'error', text: message, ...(measurementKind(text) ? { measurement: measurementKind(text) } : {}) });
  let seq: string, angle: string, distance: string, status: Status, origin: Origin;
  const historical = fields[0] === 'LOG';
  if (historical) {
    if (fields.length !== 5) return fail('LOG 需要5个字段');
    [, seq, angle, distance] = fields;
    if (!STATUSES.includes(fields[4])) return fail('回放状态须为 OK、NO_HIT 或 TIMEOUT');
    status = fields[4] as Status; origin = 'PROTEUS';
  } else if (fields[0] === 'SCAN') {
    if (fields.length !== 6) return fail('SCAN 需要6个字段');
    [, seq, angle, distance] = fields;
    if (!STATUSES.includes(fields[4])) return fail('状态须为 OK、NO_HIT 或 TIMEOUT');
    if (!ORIGINS.includes(fields[5])) return fail('来源须为 SIM、PROTEUS 或 DEVICE');
    status = fields[4] as Status; origin = fields[5] as Origin;
  } else if (['SIM', 'SRF', 'REAL', 'PROTEUS', 'DEVICE'].includes(fields[0]) && fields.length === 11) {
    [, seq, angle, distance] = fields;
    if (!['0', '1'].includes(fields[4])) return fail('旧协议 VALID 须为0或1');
    origin = fields[0] === 'SIM' ? 'SIM' : fields[0] === 'DEVICE' ? 'DEVICE' : 'PROTEUS';
    status = fields[4] === '1' ? 'OK' : origin === 'SIM' ? 'NO_HIT' : 'TIMEOUT';
  } else return fail('未知数据格式，使用 SCAN、LOG 或现有11列固件CSV');
  if (!uint(seq)) return fail('序号须为非负整数');
  if (!/^\d+(\.\d+)?$/.test(angle) || Number(angle) > 180) return fail('角度须在0°～180°之间');
  if (status === 'OK') {
    if (!uint(distance) || Number(distance) < 1) {
      return fail('有效距离须为正整数mm');
    }
  } else if (distance !== 'NA') return fail('无命中或超时的距离须为 NA');
  const outsideRange = status === 'OK' && Number(distance) > RANGE_MM;
  return { kind: 'sample', sample: {
    seq: Number(seq), angle: Number(angle), distanceMm: status === 'OK' && !outsideRange ? Number(distance) : null,
    status: outsideRange ? 'NO_HIT' : status, origin,
    ...(historical ? { historical: true } : {}), ...(outsideRange ? { outsideRange: true } : {}),
  } };
}

export function encodeSample(s: Sample): string {
  return s.historical ? `LOG,${s.seq},${s.angle},${s.distanceMm ?? 'NA'},${s.status}`
    : `SCAN,${s.seq},${s.angle},${s.distanceMm ?? 'NA'},${s.status},${s.origin}`;
}

export class LineDecoder {
  private pending = '';
  private dropping = false;
  push(chunk: string): ParsedLine[] {
    const result: ParsedLine[] = [];
    for (const c of chunk) {
      if (c === '\n') {
        if (!this.dropping) {
          const parsed = parseLine(this.pending);
          if (parsed.kind !== 'log' || parsed.text) result.push(parsed);
        }
        this.pending = ''; this.dropping = false;
      } else if (!this.dropping) {
        this.pending += c;
        if (this.pending.length > 1024) {
          const measurement = measurementKind(this.pending);
          this.pending = ''; this.dropping = true;
          result.push({ kind: 'error', text: '数据行超过1024字符，已丢弃', ...(measurement ? { measurement } : {}) });
        }
      }
    }
    return result;
  }
  reset(): void { this.pending = ''; this.dropping = false; }
}
