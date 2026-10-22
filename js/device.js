// The headband, over Web Bluetooth - and a simulated headband with the same
// interface so the app, the training and the settings can be tried without
// hardware (demo mode).
//
// Both dispatch: "connection" {connected}, "telemetry", "status", "deviceevent"
// {type, args}, "settings" and (demo only) "pattern" {mask, level, shape, durationMs}.
import {
  Command, Event, LEVEL_STYLES, Profile, Shape, UUID, ZONES, applyProfile, defaultSettings, levelFor,
  packet, parseEvent, parseSettings, parseStatus, parseTelemetry, serializeSettings,
} from './protocol.js';
import { load, save } from './store.js';

// Web Bluetooth allows one GATT operation at a time.
class GattQueue {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

class Base extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export class EyeonDevice extends Base {
  constructor() {
    super();
    this.kind = 'ble';
    this.device = null;
    this.chars = {};
    this.queue = new GattQueue();
    this.settings = null;
    this.info = '';
    this.wanted = false;
    this.retry = 0;
    // One listener per characteristic for the page's lifetime (reconnects reuse them).
    this.handlers = {
      telemetry: (e) => this.emit('telemetry', parseTelemetry(e.target.value)),
      status: (e) => this.emit('status', parseStatus(e.target.value)),
      event: (e) => this.emit('deviceevent', parseEvent(e.target.value)),
    };
  }

  static supported() {
    return !!navigator.bluetooth;
  }

  get connected() {
    return !!this.device?.gatt?.connected && !!this.chars.command;
  }

  get name() {
    return this.device?.name || 'Eyeon';
  }

  // Needs a tap (browser rule): opens the system Bluetooth chooser.
  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.coreService] }],
      optionalServices: [UUID.coreService],
    });
    save('deviceId', device.id);
    await this.attach(device);
  }

  // Reconnects to a headband chosen before, without the chooser (Chrome remembers the permission).
  async reconnectKnown() {
    if (!navigator.bluetooth?.getDevices) return false;
    const id = load('deviceId', null);
    const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
    if (!device) return false;
    await this.attach(device);
    return true;
  }

  async attach(device) {
    if (this.device !== device) {
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    }
    this.wanted = true;
    await this.setup();
  }

  async setup() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.coreService);
    const chars = {};
    for (const key of ['telemetry', 'status', 'settings', 'command', 'event', 'info']) {
      chars[key] = await svc.getCharacteristic(UUID[key]);
    }
    this.chars = chars;
    for (const key of ['telemetry', 'status', 'event']) await this.subscribe(key);
    this.info = new TextDecoder().decode(await this.queue.run(() => chars.info.readValue()));
    await this.readSettings();
    this.retry = 0;
    this.emit('connection', { connected: true });
  }

  async subscribe(key) {
    const c = this.chars[key];
    c.addEventListener('characteristicvaluechanged', this.handlers[key]);
    await this.queue.run(() => c.startNotifications());
  }

  onDisconnected() {
    this.chars = {};
    this.emit('connection', { connected: false });
    if (!this.wanted) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    setTimeout(() => {
      if (this.wanted && !this.connected) this.setup().catch(() => this.onDisconnected());
    }, delay);
  }

  disconnect() {
    this.wanted = false;
    this.device?.gatt?.disconnect();
  }

  async send(op, ...bytes) {
    if (!this.connected) throw new Error('not-connected');
    return this.queue.run(() => this.chars.command.writeValueWithResponse(packet(op, ...bytes)));
  }

  async readSettings() {
    const v = await this.queue.run(() => this.chars.settings.readValue());
    const s = parseSettings(v);
    if (s) {
      this.settings = s;
      this.emit('settings', s);
    }
    return s;
  }

  async writeSettings(s) {
    await this.queue.run(() => this.chars.settings.writeValueWithResponse(serializeSettings(s)));
    return this.readSettings();
  }
}

// ---------------------------------------------------------------------------
// Demo: a short walk down a corridor with a pole, people and a chair.
// ---------------------------------------------------------------------------

const WALK_SPEED = 1.1;  // m/s
const BEAM_DEG = 15;

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

export class DemoDevice extends Base {
  constructor() {
    super();
    this.kind = 'demo';
    this.settings = defaultSettings();
    this.info = 'Eyeon demo (simulated)';
    this.connectedFlag = false;
    this.phoneVibration = load('demoVibration', true);
    this.battery = 87;
    this.seq = 0;
    this.prev = Array(8).fill(null);
    this.prevLevel = Array(8).fill(0);
    this.tags = Array(8).fill(null);
    this.pausedUntil = 0;
    this.nextPulse = 0;
    this.overlayUntil = 0;
    this.started = 0;
    this.obstacles = [
      { kind: 'wall', x: -0.85, y: 0, r: 0, vy: 0, fixed: true },
      { kind: 'pole', x: 0.25, y: 6, r: 0.1, vy: -WALK_SPEED, respawn: () => ({ x: randomBetween(-0.5, 0.7), y: 7 }) },
      { kind: 'person', x: -0.35, y: 10, r: 0.25, vy: -WALK_SPEED - 1.2, respawn: () => ({ x: randomBetween(-0.6, 0.3), y: 12 }) },
      { kind: 'person', x: 0.9, y: -4, r: 0.25, vy: 0.45, behind: true, respawn: () => ({ x: randomBetween(0.7, 1.1), y: -5 }) },
      { kind: 'chair', x: 1.0, y: 3.5, r: 0.3, vy: -WALK_SPEED, respawn: () => ({ x: randomBetween(0.8, 1.3), y: 9 }) },
    ];
  }

  static supported() {
    return true;
  }

  get connected() {
    return this.connectedFlag;
  }

  get name() {
    return 'Eyeon (تجريبي)';
  }

  async connect() {
    this.connectedFlag = true;
    this.started = performance.now();
    this.last = this.started;
    this.timer = setInterval(() => this.tick(), 100);
    this.statusTimer = setInterval(() => this.emitStatus(), 1000);
    this.emit('connection', { connected: true });
    this.emit('settings', this.settings);
    this.emit('deviceevent', { type: Event.Hello, args: [1, 0, 0, 0] });
  }

  async reconnectKnown() {
    return false;
  }

  disconnect() {
    clearInterval(this.timer);
    clearInterval(this.statusTimer);
    this.connectedFlag = false;
    this.emit('connection', { connected: false });
  }

  setPhoneVibration(on) {
    this.phoneVibration = on;
    save('demoVibration', on);
  }

  walking(now) {
    // 24 s walking, then 6 s standing at a "crossing".
    return ((now - this.started) / 1000) % 30 < 24;
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.3, (now - this.last) / 1000);
    this.last = now;
    const walking = this.walking(now);

    for (const o of this.obstacles) {
      if (o.fixed) continue;
      const speed = o.vy + (walking ? 0 : WALK_SPEED);  // standing still: static things stop approaching
      o.y += speed * dt;
      if ((!o.behind && o.y < -2.5) || (o.behind && o.y > 5)) Object.assign(o, o.respawn());
    }

    const s = this.settings;
    const zones = ZONES.map((zone, i) => {
      let best = null;
      for (const o of this.obstacles) {
        const dist = Math.hypot(o.x, o.y) - o.r;
        let bearing = (Math.atan2(o.x, o.y) * 180) / Math.PI;
        if (bearing < 0) bearing += 360;
        let diff = Math.abs(bearing - zone.bearing);
        if (diff > 180) diff = 360 - diff;
        const visible = o.kind === 'wall' ? zone.code === 'L' : diff <= BEAM_DEG || (dist < 0.7 && diff <= 22.5);
        if (visible && dist > 0.05 && dist < 4 && (!best || dist < best.dist)) best = { dist, kind: o.kind };
      }
      const mm = best ? Math.round((best.dist * 1000) / 20) * 20 : null;
      const prev = this.prev[i];
      const speed = mm != null && prev != null ? (prev - mm) / dt : 0;  // mm/s, + = closing
      this.prev[i] = mm;
      const approaching = speed > 300;
      let level = mm == null || !s.zones[i].enabled ? 0 : levelFor(mm, s.zones[i].maxMm, s.zones[i].criticalMm);
      if (s.approachAlerts && approaching && level > 0) {
        const ttc = (mm / speed) * 1000;
        if (ttc < 800) level = 4;
        else if (ttc < 1500) level = Math.min(4, level + 1);
      }
      if (s.calmWhenStanding && !walking && level === 1 && !approaching) level = 0;
      if (s.quiet && level < 3) level = 0;
      if (this.tags[i] && this.tags[i].until < now) this.tags[i] = null;
      return {
        state: mm == null ? 'clear' : 'obstacle', mm, level, approaching,
        groundLimited: false, ultrasonic: mm != null, tof: mm != null && zone.code === 'F', suppressed: false,
        kind: best?.kind,
      };
    });

    // Keep only the most urgent zones (critical ones always stay), front first.
    const active = zones.map((z, i) => ({ z, i })).filter(({ z }) => z.level > 0);
    const sectorBonus = (i) => ([0, 1, 7].includes(i) ? 2 : [2, 6].includes(i) ? 1 : 0);
    const rank = ({ z, i }) => z.level * 1000 + sectorBonus(i) * 120 - (z.mm ?? 0) / 40;
    active.sort((a, b) => rank(a) - rank(b));  // least urgent first
    let excess = active.length - s.maxActiveZones;
    for (const a of active) {
      if (excess <= 0) break;
      if (a.z.level === 4) continue;
      a.z.level = 0;
      a.z.suppressed = true;
      excess--;
    }

    if (now < this.pausedUntil) zones.forEach((z) => z.level < 4 && (z.level = 0));
    this.battery = Math.max(5, this.battery - dt * 0.002);
    this.lastZones = zones;
    this.emit('telemetry', {
      seq: this.seq++ & 0xff,
      battery: Math.round(this.battery),
      flags: {
        walking, quiet: s.quiet, lowBattery: this.battery <= 15, sensingFault: false, fallAlert: false,
        sos: false, camera: false, paused: now < this.pausedUntil,
      },
      pitch: 4,
      zones,
      at: Date.now(),
    });
    this.vibrateFor(zones, now);
  }

  // A phone has one motor: play the rhythm of the most urgent zone.
  vibrateFor(zones, now) {
    if (!this.phoneVibration || !navigator.vibrate || now < this.overlayUntil) return;
    let top = 0;
    for (const z of zones) top = Math.max(top, z.level);
    if (top === 0 || now < this.nextPulse) return;
    const style = LEVEL_STYLES[top];
    navigator.vibrate(top === 4 ? 300 : style.onMs);
    this.nextPulse = now + (top === 4 ? 280 : style.periodMs);
  }

  emitStatus() {
    this.emit('status', {
      batteryMv: Math.round(3300 + this.battery * 8.5), battery: Math.round(this.battery), pitch: 4, roll: 0,
      profile: this.settings.profile, motion: this.walking(performance.now()) ? 2 : 1,
      uptimeS: Math.round((performance.now() - this.started) / 1000), faultMask: 0, staleMask: 0,
      imuOk: true, tofCount: 1, variant: 'lite', firmware: 'demo', sunMask: 0,
    });
  }

  playOnPhone(level, shape, durationMs) {
    if (!navigator.vibrate) return;
    const style = LEVEL_STYLES[Math.max(1, Math.min(4, level))];
    const taps = shape === Shape.Double ? 2 : shape === Shape.Triple ? 3 : 1;
    const pattern = [];
    if (level >= 4) {
      pattern.push(durationMs);
    } else {
      for (let t = 0; t < durationMs; t += style.periodMs) {
        for (let k = 0; k < taps; k++) pattern.push(taps > 1 ? 50 : style.onMs, taps > 1 && k < taps - 1 ? 60 : 0);
        pattern.push(Math.max(0, style.periodMs - taps * (taps > 1 ? 110 : style.onMs)));
      }
    }
    navigator.vibrate(pattern.filter((v, i) => v > 0 || i % 2 === 1));
    this.overlayUntil = performance.now() + durationMs;
  }

  async send(op, ...bytes) {
    const b = bytes.flat();
    const now = performance.now();
    switch (op) {
      case Command.PlayPattern: {
        const durationMs = b[3] | (b[4] << 8);
        this.emit('pattern', { mask: b[0], level: b[1], shape: b[2], durationMs });
        this.playOnPhone(b[1], b[2], durationMs);
        break;
      }
      case Command.StopPattern:
        navigator.vibrate?.(0);
        this.overlayUntil = 0;
        break;
      case Command.SetProfile:
        applyProfile(this.settings, b[0]);
        this.emit('settings', this.settings);
        this.emit('deviceevent', { type: Event.ProfileChanged, args: [b[0]] });
        break;
      case Command.SetQuiet:
        this.settings.quiet = !!b[0];
        this.emit('settings', this.settings);
        this.emit('deviceevent', { type: Event.QuietChanged, args: [b[0] ? 1 : 0] });
        break;
      case Command.ZoneTag:
        this.tags[b[0]] = { cls: b[1], until: now + (b[2] | (b[3] << 8)) };
        break;
      case Command.Pause: {
        const secs = b[0] | (b[1] << 8);
        this.pausedUntil = secs ? now + secs * 1000 : 0;
        this.emit('deviceevent', { type: Event.Paused, args: [secs ? 1 : 0] });
        break;
      }
      case Command.CameraPower:
        this.emit('deviceevent', { type: Event.CameraPower, args: [b[0] ? 1 : 0] });
        break;
      case Command.CalibrateUpright:
        this.emit('deviceevent', { type: Event.Calibration, args: [1, 1] });
        break;
      case Command.CalibrateNod:
        this.emit('deviceevent', { type: Event.Calibration, args: [2, 1] });
        break;
      case Command.FindMe:
      case Command.MotorTest:
        navigator.vibrate?.([200, 100, 200, 100, 200]);
        break;
      case Command.BatteryReport: {
        const taps = Math.max(1, Math.round(this.battery / 25));
        navigator.vibrate?.(Array.from({ length: taps * 2 - 1 }, (_, i) => (i % 2 ? 200 : 150)));
        break;
      }
      case Command.SosCountdown:
        if (b[0]) navigator.vibrate?.(Array.from({ length: b[0] * 2 }, (_, i) => (i % 2 ? 850 : 150)));
        else navigator.vibrate?.(0);
        break;
      case Command.SosSent:
        navigator.vibrate?.(800);
        break;
      case Command.FactoryReset:
        this.settings = defaultSettings();
        this.emit('settings', this.settings);
        break;
      default:
        break;
    }
  }

  async readSettings() {
    this.emit('settings', this.settings);
    return this.settings;
  }

  async writeSettings(s) {
    this.settings = structuredClone(s);
    if (this.settings.profile !== Profile.Custom) applyProfile(this.settings, this.settings.profile);
    this.emit('settings', this.settings);
    return this.settings;
  }
}
