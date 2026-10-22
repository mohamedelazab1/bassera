// Live picture of the eight zones for a sighted helper. Front is always at the
// top. The text list next to it carries the same information for screen readers.
import { LEVEL_NAMES, ZONES } from './protocol.js';
import { meters } from './speech.js';

const RANGE_MM = 4000;

export function drawRadar(canvas, telemetry, { highlightMask = 0 } = {}) {
  const size = canvas.clientWidth;
  if (!size) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const css = getComputedStyle(canvas);
  const color = (name) => css.getPropertyValue(name).trim();
  const c = size / 2;
  const rMax = size / 2 - 4;
  const rHead = size * 0.13;
  const toRadius = (mm) => rHead + Math.min(1, mm / RANGE_MM) * (rMax - rHead);

  // Range rings every metre.
  ctx.strokeStyle = color('--radar-ring');
  ctx.lineWidth = 1;
  for (let m = 1000; m <= RANGE_MM; m += 1000) {
    ctx.beginPath();
    ctx.arc(c, c, toRadius(m), 0, Math.PI * 2);
    ctx.stroke();
  }

  ZONES.forEach((zone, i) => {
    const z = telemetry?.zones?.[i];
    const start = ((zone.bearing - 22.5 - 90) * Math.PI) / 180 + 0.03;
    const end = ((zone.bearing + 22.5 - 90) * Math.PI) / 180 - 0.03;
    const level = z?.level ?? 0;

    if (highlightMask & (1 << i)) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, rMax, start, end);
      ctx.closePath();
      ctx.fillStyle = color('--radar-highlight');
      ctx.fill();
    }
    if (z?.state === 'obstacle') {
      const r = toRadius(z.mm);
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, start, end);
      ctx.closePath();
      ctx.fillStyle = color(`--level-${level}-fill`);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c, c, r, start, end);
      ctx.lineWidth = level >= 3 ? 7 : 5;
      ctx.strokeStyle = color(`--level-${level}`);
      ctx.stroke();
    } else if (z?.state === 'fault' || z?.state === 'stale') {
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(c, c, rHead + 10, start, end);
      ctx.lineWidth = 4;
      ctx.strokeStyle = color('--fault');
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Motor dot on the band.
    const mid = ((zone.bearing - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(c + Math.cos(mid) * rHead, c + Math.sin(mid) * rHead, 5, 0, Math.PI * 2);
    ctx.fillStyle = level ? color(`--level-${level}`) : color('--radar-ring');
    ctx.fill();
  });

  // Head, with the nose pointing forward.
  ctx.beginPath();
  ctx.arc(c, c, rHead - 6, 0, Math.PI * 2);
  ctx.fillStyle = color('--surface-2');
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(c - 8, c - rHead + 10);
  ctx.lineTo(c, c - rHead - 2);
  ctx.lineTo(c + 8, c - rHead + 10);
  ctx.fillStyle = color('--text');
  ctx.fill();
}

// Same information as text, one line per zone.
export function zoneLines(telemetry) {
  return ZONES.map((zone, i) => {
    const z = telemetry?.zones?.[i];
    if (!z) return `${zone.name}: مفيش بيانات`;
    if (z.state === 'fault') return `${zone.name}: الحساس مش شغال`;
    if (z.state === 'stale') return `${zone.name}: مفيش قراءة`;
    if (z.state === 'clear') return `${zone.name}: فاضي`;
    const level = z.level ? ` (${LEVEL_NAMES[z.level]})` : '';
    const moving = z.approaching ? '، بيقرب' : '';
    return `${zone.name}: ${meters(z.mm)}${level}${moving}`;
  });
}
