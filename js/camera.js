// Where pictures come from: the headband's camera unit (ESP32-CAM over BLE),
// or the phone's own rear camera as a fallback.
import { Command, UUID, crc32 } from './protocol.js';
import { load, save } from './store.js';

export const FrameSize = { QVGA: 0, VGA: 1, SVGA: 2, XGA: 3, UXGA: 4 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BandCamera extends EventTarget {
  constructor(getHeadband) {
    super();
    this.getHeadband = getHeadband;
    this.device = null;
    this.chars = null;
    this.pending = null;
    this.frame = null;
    this.keepAlive = null;
    this.onValue = (e) => this.onData(e.target.value);
    this.onGone = () => {
      this.chars = null;
      this.emit('connection', { connected: false });
    };
  }

  static supported() {
    return !!navigator.bluetooth;
  }

  get connected() {
    return !!this.device?.gatt?.connected && !!this.chars;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // Needs a tap. The headband powers the unit; the chooser keeps scanning until it boots.
  async connect() {
    await this.power(true);
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.camService] }] });
    save('cameraId', device.id);
    await this.attach(device);
  }

  async reconnectKnown() {
    if (!navigator.bluetooth?.getDevices) return false;
    const id = load('cameraId', null);
    const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
    if (!device) return false;
    await this.power(true);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.attach(device);
        return true;
      } catch {
        await sleep(1000);  // still booting
      }
    }
    return false;
  }

  async power(on) {
    const band = this.getHeadband();
    if (band?.connected) await band.send(Command.CameraPower, on ? 1 : 0).catch(() => {});
  }

  async attach(device) {
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onGone);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onGone);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.camService);
    const control = await svc.getCharacteristic(UUID.camControl);
    const data = await svc.getCharacteristic(UUID.camData);
    data.addEventListener('characteristicvaluechanged', this.onValue);
    await data.startNotifications();
    this.chars = { control, data };
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      const band = this.getHeadband();
      if (this.connected && band?.connected) band.send(Command.CameraKeepAlive).catch(() => {});
    }, 60000);
    this.emit('connection', { connected: true });
  }

  disconnect() {
    clearInterval(this.keepAlive);
    this.device?.gatt?.disconnect();
    this.power(false);
  }

  // Resolves with a JPEG Blob.
  capture({ size = FrameSize.VGA, quality = 12, timeoutMs = 25000 } = {}) {
    if (!this.connected) return Promise.reject(new Error('camera-not-connected'));
    if (this.pending) return Promise.reject(new Error('camera-busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(new Error('camera-timeout')), timeoutMs);
      this.pending = { resolve, reject, timer };
      this.getHeadband()?.send(Command.CameraKeepAlive).catch(() => {});
      this.chars.control
        .writeValueWithResponse(Uint8Array.from([0x01, size, quality]))
        .catch((e) => this.finish(e));
    });
  }

  finish(error, blob) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.frame = null;
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve(blob);
  }

  onData(view) {
    const type = view.getUint8(0);
    if (type === 0x01) {
      const len = view.getUint32(2, true);
      const chunk = view.getUint16(10, true);
      const count = Math.ceil(len / chunk);
      this.frame = { id: view.getUint8(1), len, chunk, count, buf: new Uint8Array(len), seen: new Uint8Array(count), got: 0 };
      return;
    }
    if (type === 0x04) {
      this.finish(new Error(`camera-error-${view.getUint8(2)}`));
      return;
    }
    const f = this.frame;
    if (!f || view.getUint8(1) !== f.id) return;
    if (type === 0x02) {
      const index = view.getUint16(2, true);
      const bytes = new Uint8Array(view.buffer, view.byteOffset + 4, view.byteLength - 4);
      if (index < f.count && index * f.chunk + bytes.length <= f.len) {
        f.buf.set(bytes, index * f.chunk);
        if (!f.seen[index]) {
          f.seen[index] = 1;
          f.got++;
        }
        this.emit('progress', f.got / f.count);
      }
    } else if (type === 0x03) {
      const ok = f.got === f.count && crc32(f.buf) === view.getUint32(2, true);
      this.finish(ok ? null : new Error('camera-incomplete'), ok ? new Blob([f.buf], { type: 'image/jpeg' }) : undefined);
    }
  }
}

export class PhoneCamera {
  static supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async capture() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await sleep(700);  // let exposure and focus settle
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture-failed'))), 'image/jpeg', 0.85));
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }
}
