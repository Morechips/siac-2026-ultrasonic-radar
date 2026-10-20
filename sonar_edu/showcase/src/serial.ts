export type SerialState = 'idle' | 'connecting' | 'connected' | 'error';

export class SerialConnection {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private task: Promise<void> | null = null;
  private closing = false;
  private generation = 0;
  private onText: (text: string) => void;
  private onState: (state: SerialState, message: string) => void;
  state: SerialState = 'idle';
  constructor(onText: (text: string) => void, onState: (state: SerialState, message: string) => void) {
    this.onText = onText; this.onState = onState;
  }
  get supported(): boolean { return 'serial' in navigator && window.isSecureContext; }
  private notify(state: SerialState, message: string): void { this.state = state; this.onState(state, message); }
  async connect(baudRate: number): Promise<void> {
    if (this.state === 'connecting' || this.port) return;
    if (!this.supported) { this.notify('error', '当前浏览器未提供 Web Serial，请用桌面 Chrome 打开本机页面。'); return; }
    const generation = ++this.generation;
    this.closing = false; this.notify('connecting', '请选择串口…');
    try {
      const port = await navigator.serial.requestPort();
      if (this.closing || generation !== this.generation) return;
      this.port = port;
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      if (this.closing || generation !== this.generation) { await port.close(); if (this.port === port) this.port = null; return; }
      this.notify('connected', `已连接 · ${baudRate} / 8N1`);
      this.task = this.readLoop(port);
    } catch (e) {
      if (generation !== this.generation) return;
      this.port = null;
      const err = e as DOMException;
      this.notify(err.name === 'NotFoundError' ? 'idle' : 'error', err.name === 'NotFoundError' ? '已取消选择串口' : `连接失败：${err.message}`);
    }
  }
  private async readLoop(port: SerialPort): Promise<void> {
    const decoder = new TextDecoder();
    try {
      if (!port.readable) throw new Error('串口没有可读数据流');
      this.reader = port.readable.getReader();
      while (!this.closing) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.onText(decoder.decode(value, { stream: true }));
      }
      if (!this.closing) this.notify('error', '串口已断开，保留最后画面');
    } catch (e) {
      if (!this.closing) this.notify('error', `串口中断：${(e as Error).message}`);
    } finally {
      this.reader?.releaseLock(); this.reader = null;
      try { await port.close(); } catch { /* Port may already have been removed. */ }
      if (this.port === port) this.port = null;
      if (this.closing) this.notify('idle', '已断开');
    }
  }
  async disconnect(): Promise<void> {
    this.closing = true;
    this.generation++;
    if (this.reader) { try { await this.reader.cancel(); } catch { /* Device removed. */ } }
    if (this.task) await this.task;
    this.task = null;
    // A pending requestPort/open call completes through connect's closing branch.
    this.notify('idle', '已断开');
  }
}
