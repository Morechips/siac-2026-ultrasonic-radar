import type { Sample } from './model.ts';
import type { ParsedLine } from './protocol.ts';

export type ReplayPhase = 'live' | 'replay' | 'complete' | 'interrupted';
export interface DisplayUpdate { clear: boolean; sample?: Sample; invalid?: 'live' | 'replay' }
const unchanged = (): DisplayUpdate => ({ clear: false });

/** Keeps incoming transport state separate from the frozen display. */
export class MeasurementSession {
  phase: ReplayPhase = 'live';
  private historical = false;
  private paused = false;
  private pending: Sample | null = null;
  private clearPending = false;
  private invalidPending: 'live' | 'replay' | undefined;

  receive(line: ParsedLine): DisplayUpdate {
    if (line.kind === 'replay') {
      if (line.action === 'start') {
        this.phase = 'replay'; this.historical = true;
        this.pending = null; this.invalidPending = undefined; this.clearPending = true;
      } else if (this.historical) {
        this.phase = line.action === 'end' ? 'complete' : 'interrupted';
      }
    } else if (line.kind === 'sample') {
      const historical = line.sample.historical === true;
      if (historical !== this.historical || historical && this.phase !== 'replay') {
        this.pending = null; this.clearPending = true;
      }
      this.historical = historical;
      this.phase = historical ? 'replay' : 'live';
      this.pending = line.sample; this.invalidPending = undefined;
    } else if (line.kind === 'error' && line.measurement) {
      this.historical = line.measurement === 'replay';
      this.phase = this.historical ? 'replay' : 'live';
      this.pending = null; this.clearPending = true; this.invalidPending = line.measurement;
    }
    return this.flush();
  }

  setPaused(paused: boolean): DisplayUpdate {
    this.paused = paused;
    return this.flush();
  }

  disconnect(): void {
    if (this.phase === 'replay') this.phase = 'interrupted';
    this.pending = null; this.clearPending = false; this.invalidPending = undefined;
  }

  reset(): void {
    this.phase = 'live'; this.historical = false; this.paused = false;
    this.pending = null; this.clearPending = false; this.invalidPending = undefined;
  }

  clearDisplay(): void { this.pending = null; this.clearPending = false; this.invalidPending = undefined; }

  private flush(): DisplayUpdate {
    if (this.paused) return unchanged();
    const update: DisplayUpdate = { clear: this.clearPending, ...(this.pending ? { sample: this.pending } : {}), ...(this.invalidPending ? { invalid: this.invalidPending } : {}) };
    this.pending = null; this.clearPending = false; this.invalidPending = undefined;
    return update;
  }
}
