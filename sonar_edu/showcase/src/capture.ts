import type { InputMode, Sample } from './model.ts';

export interface CaptureState {
  sample: Sample | null;
  inputMode: InputMode;
  paused: boolean;
  invalidMeasurement: boolean;
  serialConnected: boolean;
  lastExternalSampleAt: number;
  now: number;
}

export interface CaptureSnapshot {
  sample: Sample | null;
  inputMode: InputMode;
  unavailableReason?: string;
}

/** A retained screen is useful for viewing, but is not always a current observation. */
export function captureSnapshot(state: CaptureState): CaptureSnapshot {
  let unavailableReason: string | undefined;
  if (state.paused) unavailableReason = '展示已暂停，请继续后再记录测量。';
  else if (state.invalidMeasurement) unavailableReason = '最近一笔测量帧无效，请等待新的有效帧。';
  else if (!state.sample) unavailableReason = '还没有测量结果，先完成一次测量。';
  else if (state.inputMode === 'serial' && !state.sample.historical) {
    if (!state.serialConnected) unavailableReason = '串口已断开，最后画面不能作为当前测量记录。';
    else if (!Number.isFinite(state.now) || !Number.isFinite(state.lastExternalSampleAt) ||
      state.lastExternalSampleAt <= 0 || state.now < state.lastExternalSampleAt ||
      state.now - state.lastExternalSampleAt > 2000) {
      unavailableReason = '超过2秒没有新测量，请等待新的串口样本。';
    }
  }
  return {
    sample: state.sample ? { ...state.sample } : null,
    inputMode: state.inputMode,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}
