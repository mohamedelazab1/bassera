// Arabic speech output and voice commands.
//
// Output mode "voice" speaks with the phone's Arabic text-to-speech voice.
// Mode "screenreader" leaves speaking to TalkBack / VoiceOver through an
// aria-live region, so the two never talk over each other.
import { load, save } from './store.js';

let voice = null;
let mode = load('speechMode', 'voice');
let rate = load('speechRate', 1);
let liveRegion = null;
let logRegion = null;

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  voice = voices.find((v) => v.lang === 'ar-EG') || voices.find((v) => v.lang?.startsWith('ar')) || null;
}

export function initSpeech({ live, log }) {
  liveRegion = live;
  logRegion = log;
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }
}

export const speechMode = () => mode;
export const speechRate = () => rate;
export function setSpeechMode(m) {
  mode = m;
  save('speechMode', m);
}
export function setSpeechRate(r) {
  rate = r;
  save('speechRate', r);
}
export const hasArabicVoice = () => !!voice;

// Speak a message. `interrupt` cuts off whatever is being said (urgent news).
// Resolves when the phone has finished saying it (or right away for the screen reader).
export function say(text, { interrupt = false } = {}) {
  if (!text) return Promise.resolve();
  if (logRegion) logRegion.textContent = text;
  if (mode === 'screenreader' || !('speechSynthesis' in window)) {
    if (liveRegion) {
      liveRegion.textContent = '';
      setTimeout(() => (liveRegion.textContent = text), 50);
    }
    return Promise.resolve();
  }
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice?.lang || 'ar-EG';
  if (voice) u.voice = voice;
  u.rate = rate;
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 1500 + (text.length * 110) / rate);
    u.onend = u.onerror = () => {
      clearTimeout(fallback);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

export const stopSpeaking = () => 'speechSynthesis' in window && speechSynthesis.cancel();

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
export const canListen = () => !!Recognition;

// One spoken phrase (Egyptian Arabic). Resolves with the alternatives heard.
export function listen({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Recognition) {
      reject(new Error('unsupported'));
      return;
    }
    const r = new Recognition();
    r.lang = 'ar-EG';
    r.interimResults = false;
    r.maxAlternatives = 3;
    const timer = setTimeout(() => r.abort(), timeoutMs);
    r.onresult = (e) => {
      clearTimeout(timer);
      resolve(Array.from(e.results[0], (alt) => alt.transcript));
    };
    r.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(e.error || 'error'));
    };
    r.onend = () => {
      clearTimeout(timer);
      resolve([]);
    };
    r.start();
  });
}

// Keyword spotting is more forgiving than exact phrases for dialect and noise.
const COMMANDS = [
  ['describe', ['قدامي', 'ايه اللي', 'إيه اللي', 'شوف', 'وصف', 'اوصف', 'أوصف', 'المكان']],
  ['read', ['اقرا', 'اقرأ', 'إقرا', 'مكتوب', 'الكلام', 'يافطه', 'يافطة', 'ورقه', 'ورقة']],
  ['battery', ['بطاري', 'شحن']],
  ['sos', ['استغاث', 'نجده', 'نجدة', 'الحقوني', 'إلحقوني', 'طوارئ', 'مساعده', 'مساعدة']],
  ['resume', ['كمل', 'كمّل', 'رجع', 'شغل الاهتزاز']],
  ['pause', ['وقف', 'إيقاف', 'ايقاف', 'استنى']],
  ['quietOn', ['هادي', 'اسكت', 'صامت', 'هدوء']],
  ['quietOff', ['عادي', 'رجعه عادي']],
  ['indoor', ['جوه', 'جوا', 'البيت', 'داخل']],
  ['outdoor', ['الشارع', 'بره', 'برا', 'خارج']],
  ['crowd', ['زحمه', 'زحمة', 'ناس كتير']],
  ['findMe', ['فين', 'دور', 'مش لاقي']],
  ['status', ['حالة', 'حاله', 'الحساسات']],
];

export function matchCommand(phrases) {
  for (const phrase of phrases) {
    const p = phrase.replace(/[أإآ]/g, 'ا');
    for (const [action, words] of COMMANDS) {
      if (words.some((w) => p.includes(w.replace(/[أإآ]/g, 'ا')))) return action;
    }
  }
  return null;
}

// Arabic counting: ثانية / ثانيتين / ٣-١٠ ثواني / ١١+ ثانية.
export function secondsAr(n) {
  if (n === 1) return 'ثانية واحدة';
  if (n === 2) return 'ثانيتين';
  if (n >= 3 && n <= 10) return `${n} ثواني`;
  return `${n} ثانية`;
}

// "1.5 m" the way it is said in Egypt.
export function meters(mm) {
  if (mm == null) return '';
  if (mm < 750) return 'أقل من متر';
  const half = Math.round(mm / 500) / 2;
  const whole = Math.floor(half);
  const hasHalf = half - whole >= 0.5;
  const words = ['', 'متر', 'مترين', 'تلاتة متر', 'أربعة متر', 'خمسة متر'];
  const base = words[whole] ?? `${whole} متر`;
  return hasHalf ? `${base} ونص` : base;
}
