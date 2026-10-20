import { RANGE_MM } from './model.ts';
import type { Origin, Sample, Status } from './model.ts';

export type ParsedLine = { kind: 'sample'; sample: Sample } | { kind: 'log'; text: string } | { kind: 'error'; text: string };
const ORIGINS = ['SIM', 'PROTEUS', 'DEVICE'];
const STATUSES = ['OK', 'NO_HIT', 'TIMEOUT'];
const DIAGNOSTICS = /^(BOOT|BUS|OLED|ERR|SRC|STATUS|INFO|WARN)(,|$)/;
const uint = (s: string) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s));

export function parseLine(line: string): ParsedLine {
  const text = line.trim();
  if (!text || DIAGNOSTICS.test(text)) return { kind: 'log', text };
  const fields = text.split(',').map(s => s.trim());
  let seq: string, angle: string, distance: string, status: Status, origin: Origin;
  if (fields[0] === 'SCAN') {
    if (fields.length !== 6) return { kind: 'error', text: 'SCAN 需要6个字段' };
    [, seq, angle, distance] = fields;
    if (!STATUSES.includes(fields[4])) return { kind: 'error', text: '状态须为 OK、NO_HIT 或 TIMEOUT' };
    if (!ORIGINS.includes(fields[5])) return { kind: 'error', text: '来源须为 SIM、PROTEUS 或 DEVICE' };
    status = fields[4] as Status; origin = fields[5] as Origin;
  } else if (['SIM', 'SRF', 'REAL', 'PROTEUS', 'DEVICE'].includes(fields[0]) && fields.length === 11) {
    [, seq, angle, distance] = fields;
    if (!['0', '1'].includes(fields[4])) return { kind: 'error', text: '旧协议 VALID 须为0或1' };
    origin = fields[0] === 'SIM' ? 'SIM' : fields[0] === 'DEVICE' ? 'DEVICE' : 'PROTEUS';
    status = fields[4] === '1' ? 'OK' : origin === 'SIM' ? 'NO_HIT' : 'TIMEOUT';
  } else return { kind: 'error', text: '未知数据格式，使用 SCAN 协议或现有11列固件CSV' };
  if (!uint(seq)) return { kind: 'error', text: '序号须为非负整数' };
  if (!/^\d+(\.\d+)?$/.test(angle) || Number(angle) > 180) return { kind: 'error', text: '角度须在0°～180°之间' };
  if (status === 'OK') {
    if (!uint(distance) || Number(distance) < 1 || Number(distance) > RANGE_MM) {
      return { kind: 'error', text: '有效距离须为1～2500mm整数' };
    }
  } else if (distance !== 'NA') return { kind: 'error', text: '无命中或超时的距离须为 NA' };
  return { kind: 'sample', sample: { seq: Number(seq), angle: Number(angle), distanceMm: status === 'OK' ? Number(distance) : null, status, origin } };
}

export function encodeSample(s: Sample): string {
  return `SCAN,${s.seq},${s.angle},${s.distanceMm ?? 'NA'},${s.status},${s.origin}`;
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
          this.pending = ''; this.dropping = true;
          result.push({ kind: 'error', text: '数据行超过1024字符，已丢弃' });
        }
      }
    }
    return result;
  }
  reset(): void { this.pending = ''; this.dropping = false; }
}
