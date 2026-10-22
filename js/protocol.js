// Mirror of firmware/lib/eyeon_core/src/{protocol,settings,haptic_policy}.h.
// Keep in sync with the firmware - tests/protocol.test.mjs checks it against
// reference packets produced by the firmware code (tests/golden.json).

const BASE = '-2c4b-4f0e-9a7d-3b1c5e0a9d01';
export const UUID = {
  coreService: `e7e00001${BASE}`,
  telemetry: `e7e00002${BASE}`,
  status: `e7e00003${BASE}`,
  settings: `e7e00004${BASE}`,
  command: `e7e00005${BASE}`,
  event: `e7e00006${BASE}`,
  info: `e7e00007${BASE}`,
  camService: `e7e00101${BASE}`,
  camControl: `e7e00102${BASE}`,
  camData: `e7e00103${BASE}`,
  camStatus: `e7e00104${BASE}`,
};

// Clockwise from straight ahead - the index is the zone number used everywhere.
export const ZONES = [
  { code: 'F', name: 'قدام', bearing: 0 },
  { code: 'FR', name: 'قدام يمين', bearing: 45 },
  { code: 'R', name: 'يمين', bearing: 90 },
  { code: 'BR', name: 'ورا يمين', bearing: 135 },
  { code: 'B', name: 'ورا', bearing: 180 },
  { code: 'BL', name: 'ورا شمال', bearing: 225 },
  { code: 'L', name: 'شمال', bearing: 270 },
  { code: 'FL', name: 'قدام شمال', bearing: 315 },
];
export const LEVEL_NAMES = ['', 'بعيد', 'متوسط', 'قريب', 'قريب جداً'];

export const Command = {
  PlayPattern: 0x01, StopPattern: 0x02, MotorTest: 0x03, SetProfile: 0x04, SetQuiet: 0x05,
  CameraPower: 0x06, ZoneTag: 0x07, FindMe: 0x08, SosCountdown: 0x09, SosSent: 0x0a,
  CalibrateUpright: 0x0b, CalibrateNod: 0x0c, ResetCalibration: 0x0d, FactoryReset: 0x0e,
  Reboot: 0x0f, BatteryReport: 0x10, Pause: 0x11, CameraKeepAlive: 0x12,
};
export const Event = {
  Button: 0x01, FallDetected: 0x02, BatteryLow: 0x03, BatteryCritical: 0x04, ZoneFault: 0x05,
  SensingFault: 0x06, SosRequest: 0x07, SosCancel: 0x08, ProfileChanged: 0x09, QuietChanged: 0x0a,
  CameraPower: 0x0b, Calibration: 0x0c, Hello: 0x0d, Paused: 0x0e,
};
export const Gesture = { Single: 1, Double: 2, Long: 3, VeryLong: 4 };
export const Shape = { Off: 0, Single: 1, Double: 2, Triple: 3, Continuous: 4 };
export const ObjectClass = { None: 0, Person: 1, Vehicle: 2, Animal: 3, Other: 4 };
export const Profile = { Indoor: 0, Outdoor: 1, Crowd: 2, Custom: 3 };
export const PROFILE_NAMES = ['داخلي', 'شارع', 'زحمة', 'مخصص'];
export const Encoding = { Discrete: 0, Proportional: 1 };
export const MOTION_NAMES = ['مش معروف', 'واقف', 'ماشي'];

// [strength 0-255, tap ms, period ms] per level - firmware kLevelStyles.
export const LEVEL_STYLES = [
  { strength: 0, onMs: 0, periodMs: 0 },
  { strength: 110, onMs: 70, periodMs: 900 },
  { strength: 160, onMs: 80, periodMs: 450 },
  { strength: 210, onMs: 90, periodMs: 250 },
  { strength: 255, onMs: 1000, periodMs: 1000 },
];

export const PRESETS = {
  [Profile.Indoor]: {
    maxMm: [2000, 1500, 800, 700, 800, 700, 800, 1500],
    criticalMm: [400, 350, 250, 250, 250, 250, 250, 350],
    maxActiveZones: 3,
  },
  [Profile.Outdoor]: {
    maxMm: [3000, 2000, 1200, 1000, 1200, 1000, 1200, 2000],
    criticalMm: [500, 400, 300, 300, 300, 300, 300, 400],
    maxActiveZones: 3,
  },
  [Profile.Crowd]: {
    maxMm: [1500, 1000, 500, 500, 600, 500, 500, 1000],
    criticalMm: [400, 300, 200, 200, 200, 200, 200, 300],
    maxActiveZones: 2,
  },
};

export const FLAG = {
  walking: 0x01, quiet: 0x02, lowBattery: 0x04, sensingFault: 0x08,
  fallAlert: 0x10, sos: 0x20, camera: 0x40, paused: 0x80,
};

export const SETTINGS_SIZE = 54;
const SETTINGS_MAGIC = 0xe5;
const SETTINGS_VERSION = 1;

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

let crcTable = null;
export function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}

const bytesOf = (data) =>
  data instanceof DataView ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

// The firmware computes these boundaries in single precision floats.
const f32 = Math.fround;
export function levelFor(mm, maxMm, criticalMm) {
  if (mm == null || mm > maxMm) return 0;
  if (mm <= criticalMm) return 4;
  if (mm <= Math.trunc(f32(f32(maxMm) * f32(0.4)))) return 3;
  if (mm <= Math.trunc(f32(f32(maxMm) * f32(0.66)))) return 2;
  return 1;
}

export function parseTelemetry(data) {
  const b = bytesOf(data);
  if (b.length < 20) return null;
  const flags = b[2];
  const zones = [];
  for (let i = 0; i < 8; i++) {
    const d = b[4 + i];
    const z = b[12 + i];
    let state = 'obstacle';
    if (d === 0) state = 'clear';
    else if (d === 254) state = 'stale';
    else if (d === 255) state = 'fault';
    zones.push({
      state,
      mm: state === 'obstacle' ? d * 20 : null,
      level: z & 0x07,
      approaching: !!(z & 0x08),
      groundLimited: !!(z & 0x10),
      ultrasonic: !!(z & 0x20),
      tof: !!(z & 0x40),
      suppressed: !!(z & 0x80),
    });
  }
  const flagMap = {};
  for (const [k, v] of Object.entries(FLAG)) flagMap[k] = !!(flags & v);
  return { seq: b[0], battery: b[1], flags: flagMap, pitch: (b[3] << 24) >> 24, zones, at: Date.now() };
}

export function parseStatus(data) {
  const b = bytesOf(data);
  if (b.length < 20) return null;
  const i8 = (v) => (v << 24) >> 24;
  return {
    batteryMv: b[1] | (b[2] << 8),
    battery: b[3],
    pitch: i8(b[4]),
    roll: i8(b[5]),
    profile: b[6],
    motion: b[7],
    uptimeS: (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0,
    faultMask: b[12],
    staleMask: b[13],
    imuOk: !!(b[14] & 0x01),
    tofCount: (b[14] >> 1) & 0x07,
    variant: (b[14] >> 4) & 0x01 ? 'plus' : 'lite',
    firmware: `${b[15]}.${b[16]}.${b[17]}`,
    sunMask: b[18],
  };
}

export function parseEvent(data) {
  const b = bytesOf(data);
  return { type: b[0], args: Array.from(b.slice(1)) };
}

export function defaultSettings() {
  const s = {
    profile: Profile.Outdoor,
    encoding: Encoding.Discrete,
    intensityPct: 80,
    maxActiveZones: 3,
    approachAlerts: true,
    groundFilter: true,
    fallDetection: true,
    calmWhenStanding: true,
    quiet: false,
    tactons: true,
    cameraTimeoutS: 120,
    userHeightCm: 170,
    airTempC: 30,
    zones: Array.from({ length: 8 }, () => ({ enabled: true, maxMm: 2000, criticalMm: 400 })),
  };
  return applyProfile(s, Profile.Outdoor);
}

export function applyProfile(s, profile) {
  s.profile = profile;
  const p = PRESETS[profile];
  if (!p) return s;
  s.zones.forEach((z, i) => {
    z.maxMm = p.maxMm[i];
    z.criticalMm = p.criticalMm[i];
  });
  s.maxActiveZones = p.maxActiveZones;
  return s;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sanitize(s) {
  if (!(s.profile >= 0 && s.profile <= 3)) s.profile = Profile.Custom;
  if (!(s.encoding >= 0 && s.encoding <= 1)) s.encoding = Encoding.Discrete;
  s.intensityPct = clamp(Math.round(s.intensityPct), 20, 100);
  s.maxActiveZones = clamp(Math.round(s.maxActiveZones), 1, 8);
  s.userHeightCm = clamp(Math.round(s.userHeightCm), 100, 220);
  s.airTempC = clamp(Math.round(s.airTempC), -10, 55);
  s.cameraTimeoutS = clamp(Math.round(s.cameraTimeoutS), 0, 255);
  for (const z of s.zones) {
    z.maxMm = clamp(Math.round(z.maxMm), 300, 4000);
    z.criticalMm = clamp(Math.round(z.criticalMm), 100, Math.min(z.maxMm - 100, 1000));
  }
  return s;
}

export function serializeSettings(s) {
  const b = new Uint8Array(SETTINGS_SIZE);
  const put16 = (at, v) => {
    b[at] = v & 0xff;
    b[at + 1] = (v >> 8) & 0xff;
  };
  b[0] = SETTINGS_MAGIC;
  b[1] = SETTINGS_VERSION;
  b[2] = s.profile;
  b[3] = s.encoding;
  b[4] = s.intensityPct;
  b[5] = s.maxActiveZones;
  b[6] = (s.approachAlerts ? 0x01 : 0) | (s.groundFilter ? 0x02 : 0) | (s.fallDetection ? 0x04 : 0) |
    (s.calmWhenStanding ? 0x08 : 0) | (s.quiet ? 0x10 : 0) | (s.tactons ? 0x20 : 0);
  b[7] = s.cameraTimeoutS;
  put16(8, s.userHeightCm);
  b[10] = s.airTempC & 0xff;
  b[11] = 0;
  s.zones.forEach((z, i) => {
    const at = 12 + i * 5;
    b[at] = z.enabled ? 1 : 0;
    put16(at + 1, z.maxMm);
    put16(at + 3, z.criticalMm);
  });
  put16(52, crc16(b.subarray(0, 52)));
  return b;
}

export function parseSettings(data) {
  const b = bytesOf(data);
  if (b.length < SETTINGS_SIZE || b[0] !== SETTINGS_MAGIC || b[1] !== SETTINGS_VERSION) return null;
  const get16 = (at) => b[at] | (b[at + 1] << 8);
  if (crc16(b.subarray(0, 52)) !== get16(52)) return null;
  const s = {
    profile: b[2],
    encoding: b[3],
    intensityPct: b[4],
    maxActiveZones: b[5],
    approachAlerts: !!(b[6] & 0x01),
    groundFilter: !!(b[6] & 0x02),
    fallDetection: !!(b[6] & 0x04),
    calmWhenStanding: !!(b[6] & 0x08),
    quiet: !!(b[6] & 0x10),
    tactons: !!(b[6] & 0x20),
    cameraTimeoutS: b[7],
    userHeightCm: get16(8),
    airTempC: (b[10] << 24) >> 24,
    zones: [],
  };
  for (let i = 0; i < 8; i++) {
    const at = 12 + i * 5;
    s.zones.push({ enabled: b[at] !== 0, maxMm: get16(at + 1), criticalMm: get16(at + 3) });
  }
  return sanitize(s);
}

export const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
export const packet = (op, ...bytes) => Uint8Array.from([op, ...bytes.flat()]);
