// Haptic-language trainer: short guided lessons, then a quiz that brings back
// the zones and distances the user gets wrong most often.
import { Command, Shape, ZONES, u16 } from './protocol.js';
import { say } from './speech.js';
import { load, save } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bit = (zone) => 1 << zone;
const FRONT = 0;
const FRONT_RIGHT = 1;

export const LESSONS = [
  {
    title: 'الدرس ١: مكان الاهتزاز هو مكان العائق',
    intro: 'كل موتور في البندانة بيمثل اتجاه. هشغّل كل موتور لوحده وأقولك اسمه.',
    steps: ZONES.map((z, i) => ({ text: z.name, mask: bit(i), level: 3, ms: 1400 })),
  },
  {
    title: 'الدرس ٢: الإيقاع هو المسافة',
    intro: 'زي حساس الركن في العربية: كل ما العائق يقرب، النبض يبقى أسرع وأقوى.',
    steps: [
      { text: 'بعيد: نبضة خفيفة كل ثانية تقريباً.', mask: bit(FRONT), level: 1, ms: 3600 },
      { text: 'متوسط: نبضتين في الثانية.', mask: bit(FRONT), level: 2, ms: 2700 },
      { text: 'قريب: نبض سريع وقوي.', mask: bit(FRONT), level: 3, ms: 2000 },
      { text: 'قريب جداً: اهتزاز مستمر، يعني اقف فوراً.', mask: bit(FRONT), level: 4, ms: 1500 },
    ],
  },
  {
    title: 'الدرس ٣: نوع العائق لما الكاميرا شغالة',
    intro: 'لما الموبايل يتعرف على العائق من الكاميرا، شكل النبضة بيتغير.',
    steps: [
      { text: 'نبضة واحدة: عائق عادي.', mask: bit(FRONT), level: 2, shape: Shape.Single, ms: 2700 },
      { text: 'نبضتين ورا بعض: شخص.', mask: bit(FRONT), level: 2, shape: Shape.Double, ms: 2700 },
      { text: 'تلات نبضات: عربية أو موتوسيكل أو عجلة.', mask: bit(FRONT), level: 2, shape: Shape.Triple, ms: 2700 },
    ],
  },
  {
    title: 'الدرس ٤: مثال من الشارع',
    intro: 'فيه عمود قدامك على اليمين وانت ماشي ناحيته. حس الإيقاع وهو بيسرع.',
    steps: [
      { text: 'لسه بعيد.', mask: bit(FRONT_RIGHT), level: 1, ms: 2700 },
      { text: 'بيقرب.', mask: bit(FRONT_RIGHT), level: 2, ms: 2200 },
      { text: 'قريب. ميّل ناحية الشمال شوية.', mask: bit(FRONT_RIGHT), level: 3, ms: 2000 },
      { text: 'لو وصل للاهتزاز المستمر، اقف.', mask: bit(FRONT_RIGHT), level: 4, ms: 1200 },
      { text: 'ولما تعدّيه، الاهتزاز بيقف لوحده.' },
    ],
  },
];

export class Trainer extends EventTarget {
  constructor(getDevice) {
    super();
    this.getDevice = getDevice;
    this.running = false;
    this.question = null;
    this.stats = load('trainingStats', null) ?? Trainer.emptyStats();
  }

  static emptyStats() {
    return { tries: 0, correct: 0, zoneMiss: Array(8).fill(0), levelMiss: Array(5).fill(0) };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async play(mask, level, shape = Shape.Single, ms = 2500) {
    const device = this.getDevice();
    if (!device?.connected) throw new Error('not-connected');
    this.emit('play', { mask, level, shape, ms });
    await device.send(Command.PlayPattern, mask, level, shape, u16(ms));
    await sleep(ms + 300);
  }

  stop() {
    this.running = false;
    this.getDevice()?.send(Command.StopPattern).catch(() => {});
    this.emit('done');
  }

  async runLesson(index) {
    const lesson = LESSONS[index];
    this.running = true;
    say(`${lesson.title}. ${lesson.intro}`, { interrupt: true });
    await sleep(6000);
    for (const step of lesson.steps) {
      if (!this.running) return;
      say(step.text, { interrupt: true });
      await sleep(Math.min(2600, 700 + step.text.length * 55));
      if (!this.running) return;
      if (step.mask) await this.play(step.mask, step.level, step.shape ?? Shape.Single, step.ms);
    }
    this.running = false;
    say('خلص الدرس.');
    this.emit('done');
  }

  // Zones and levels with more mistakes are picked more often.
  newQuestion() {
    const pick = (misses) => {
      const weights = misses.map((m) => 1 + m * 2);
      let r = Math.random() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
      }
      return weights.length - 1;
    };
    this.question = { zone: pick(this.stats.zoneMiss), level: 1 + pick(this.stats.levelMiss.slice(1)) };
    return this.question;
  }

  async askQuestion() {
    const q = this.question ?? this.newQuestion();
    await this.play(bit(q.zone), q.level, Shape.Single, q.level === 4 ? 1500 : 2700);
  }

  answer(zone, level) {
    const q = this.question;
    if (!q) return null;
    const zoneOk = zone === q.zone;
    const levelOk = level === q.level;
    const s = this.stats;
    s.tries++;
    if (zoneOk && levelOk) s.correct++;
    s.zoneMiss[q.zone] = zoneOk ? Math.max(0, s.zoneMiss[q.zone] - 1) : s.zoneMiss[q.zone] + 1;
    s.levelMiss[q.level] = levelOk ? Math.max(0, s.levelMiss[q.level] - 1) : s.levelMiss[q.level] + 1;
    save('trainingStats', s);
    this.question = null;
    return { zoneOk, levelOk, expected: q };
  }

  resetStats() {
    this.stats = Trainer.emptyStats();
    save('trainingStats', this.stats);
  }
}
