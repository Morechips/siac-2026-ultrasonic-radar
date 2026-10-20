import { RANGE_MM } from './model.ts';
import type { Sample } from './model.ts';

export class RadarView {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private trail: Sample[] = [];
  private angle = 90;
  private canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }
  private resize(): void {
    this.width = this.canvas.clientWidth; this.height = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.width * dpr; this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.draw();
  }
  update(trail: Sample[], angle: number): void { this.trail = trail; this.angle = angle; this.draw(); }
  private draw(): void {
    const c = this.ctx, w = this.width, h = this.height;
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h - 32, r = Math.max(10, Math.min(w / 2 - 44, h - 64));
    const point = (angle: number, dist: number): [number, number] => {
      const rad = angle * Math.PI / 180;
      return [cx + Math.cos(rad) * r * dist / RANGE_MM, cy - Math.sin(rad) * r * dist / RANGE_MM];
    };
    c.beginPath(); c.arc(cx, cy, r, Math.PI, Math.PI * 2); c.lineTo(cx, cy); c.closePath();
    c.fillStyle = '#f1f7f4'; c.fill();
    c.save(); c.clip();
    c.strokeStyle = '#e5efea'; c.lineWidth = 1;
    for (let x = cx - r; x <= cx + r; x += r / 10) {
      c.beginPath(); c.moveTo(x, cy - r); c.lineTo(x, cy); c.stroke();
    }
    for (let y = cy; y >= cy - r; y -= r / 10) {
      c.beginPath(); c.moveTo(cx - r, y); c.lineTo(cx + r, y); c.stroke();
    }
    c.restore();
    for (let i = 1; i <= 5; i++) {
      c.beginPath(); c.arc(cx, cy, r * i / 5, Math.PI, Math.PI * 2);
      c.strokeStyle = i === 5 ? '#b4cfc3' : '#d2e3da'; c.lineWidth = i === 5 ? 1.3 : 1; c.stroke();
    }
    for (let a = 0; a <= 180; a += 30) {
      const p = point(a, RANGE_MM);
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(...p); c.strokeStyle = '#d2e3da'; c.stroke();
      const label = point(a, RANGE_MM * (1 + 23 / r));
      c.font = '11px "Segoe UI", sans-serif'; c.fillStyle = '#83988d';
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(`${a}°`, ...label);
    }
    const angleRad = this.angle * Math.PI / 180;
    c.beginPath(); c.moveTo(cx, cy);
    c.arc(cx, cy, r, -angleRad - 0.085, -angleRad + 0.085);
    c.closePath(); c.fillStyle = 'rgba(28, 139, 112, 0.07)'; c.fill();
    this.trail.forEach((s, i) => {
      const hit = s.status === 'OK' && s.distanceMm !== null;
      const [x, y] = point(s.angle, hit ? s.distanceMm! : RANGE_MM);
      const current = i === this.trail.length - 1;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y);
      c.setLineDash(hit ? [] : [3, 5]);
      c.strokeStyle = current ? '#12866b' : hit ? '#8dbdaf' : '#d0dfd7';
      c.lineWidth = current ? 1.8 : 1; c.stroke(); c.setLineDash([]);
      if (hit) {
        if (current) {
          c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.fillStyle = '#d3ece2'; c.fill();
        }
        c.beginPath(); c.arc(x, y, current ? 4 : 2.5, 0, Math.PI * 2);
        c.fillStyle = s.distanceMm! < 500 ? '#d89046' : '#198b70'; c.fill();
        c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
      }
    });
    c.font = '10px "Segoe UI", sans-serif'; c.textAlign = 'left'; c.fillStyle = '#7f978a';
    for (let i = 1; i <= 5; i++) c.fillText(`${i * 50}`, cx + r * i / 5 - 14, cy + 17);
    c.fillText('cm', cx + r + 10, cy + 17);
    c.beginPath(); c.arc(cx, cy, 6, 0, Math.PI * 2); c.fillStyle = '#15836a'; c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
  }
}
