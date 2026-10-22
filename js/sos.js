// Emergency help: countdown (cancel any time) -> location -> message to the
// first saved contact. A web page is not allowed to send an SMS on its own, so
// the last step opens WhatsApp / SMS with the message ready and keeps a big
// "send" button on screen.
import { Command } from './protocol.js';
import { say, secondsAr } from './speech.js';
import { load, save } from './store.js';

// Egyptian local numbers (01xxxxxxxxx) to the international form WhatsApp links need.
export function internationalNumber(phone) {
  let d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `20${d.slice(1)}`;
  return d;
}

export class Sos extends EventTarget {
  constructor(getDevice) {
    super();
    this.getDevice = getDevice;
    this.contacts = load('contacts', []);
    this.message = load('sosMessage', 'محتاج مساعدة دلوقتي. ده مكاني:');
    this.state = 'idle';  // idle | countdown | ready | sent
    this.remaining = 0;
    this.position = null;
  }

  emitState() {
    this.dispatchEvent(new CustomEvent('state', { detail: this }));
  }

  setContacts(list) {
    this.contacts = list;
    save('contacts', list);
  }

  setMessage(text) {
    this.message = text;
    save('sosMessage', text);
  }

  start(reason = 'app', seconds = 10) {
    if (this.state === 'countdown' || this.state === 'ready') return;
    this.state = 'countdown';
    this.reason = reason;
    this.remaining = seconds;
    this.getDevice()?.send(Command.SosCountdown, seconds).catch(() => {});
    const intro = reason === 'fall'
      ? 'حسّيت إنك وقعت. لو انت كويس دوس على زرار البندانة مرة واحدة.'
      : 'استغاثة.';
    say(`${intro} هبعت رسالة استغاثة بعد ${secondsAr(seconds)}. دوس إلغاء لو مش محتاج.`, { interrupt: true });
    this.locate();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    this.emitState();
  }

  tick() {
    if (this.state !== 'countdown') return;
    this.remaining--;
    if (this.remaining > 0 && (this.remaining <= 5 || this.remaining % 5 === 0)) say(String(this.remaining));
    if (this.remaining <= 0) {
      clearInterval(this.timer);
      this.ready();
    }
    this.emitState();
  }

  cancel({ fromBand = false } = {}) {
    if (this.state === 'idle') return;
    clearInterval(this.timer);
    this.state = 'idle';
    if (!fromBand) this.getDevice()?.send(Command.SosCountdown, 0).catch(() => {});
    say('اتلغت الاستغاثة.', { interrupt: true });
    this.emitState();
  }

  locate() {
    this.position = null;
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        this.position = p.coords;
        this.emitState();
      },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  text() {
    const where = this.position
      ? `https://maps.google.com/?q=${this.position.latitude.toFixed(6)},${this.position.longitude.toFixed(6)}`
      : '(المكان مش متاح دلوقتي)';
    return `${this.message} ${where}\n- Eyeon`;
  }

  links(contact) {
    const body = encodeURIComponent(this.text());
    return {
      whatsapp: `https://wa.me/${internationalNumber(contact.phone)}?text=${body}`,
      sms: `sms:${contact.phone}?body=${body}`,
      call: `tel:${contact.phone}`,
    };
  }

  ready() {
    clearInterval(this.timer);
    this.state = 'ready';
    this.emitState();
    if (!this.contacts.length) {
      say('مفيش أرقام طوارئ متسجلة. ضيف رقم من صفحة الطوارئ.', { interrupt: true });
      return;
    }
    say('رسالة الاستغاثة جاهزة. دوس على زرار ابعت الكبير.', { interrupt: true });
    this.send(this.contacts[0], 'whatsapp', { automatic: true });
  }

  // Without a tap the browser may block opening another app; the button stays for that case.
  send(contact, channel = 'whatsapp', { automatic = false } = {}) {
    const opened = window.open(this.links(contact)[channel], '_blank');
    if (!opened && automatic) return false;
    if (!opened) location.href = this.links(contact)[channel];
    this.state = 'sent';
    this.getDevice()?.send(Command.SosSent).catch(() => {});
    this.emitState();
    return true;
  }

  close() {
    this.state = 'idle';
    this.emitState();
  }
}
