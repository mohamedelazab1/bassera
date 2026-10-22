// Recognition on the phone (much faster than any chip that fits in the band):
//   - objects: COCO-SSD in the browser, works offline once cached
//   - text:    Tesseract (Arabic + English), works offline once cached
//   - scene:   Claude, optional, needs internet and the user's own API key
import { ObjectClass, ZONES } from './protocol.js';
import { meters } from './speech.js';

const CDN = {
  tf: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  coco: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
  anthropic: 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.0/+esm',
};
const MODEL = 'claude-opus-5-5';
const CAMERA_HFOV_DEG = 64;  // OV2640 stock lens and most phone main cameras

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error('download-failed'));
      };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

const LABELS = {
  person: 'شخص', bicycle: 'عجلة', car: 'عربية', motorcycle: 'موتوسيكل', airplane: 'طيارة', bus: 'أتوبيس',
  train: 'قطر', truck: 'عربية نقل', boat: 'مركب', 'traffic light': 'إشارة مرور', 'fire hydrant': 'حنفية حريق',
  'stop sign': 'علامة قف', 'parking meter': 'عداد ركن', bench: 'دكة', bird: 'عصفورة', cat: 'قطة', dog: 'كلب',
  horse: 'حصان', sheep: 'خروف', cow: 'بقرة', elephant: 'فيل', bear: 'دب', zebra: 'حمار وحشي', giraffe: 'زرافة',
  backpack: 'شنطة ضهر', umbrella: 'شمسية', handbag: 'شنطة إيد', tie: 'كرافتة', suitcase: 'شنطة سفر',
  frisbee: 'فريسبي', skis: 'زلاجات', snowboard: 'لوح تزلج', 'sports ball': 'كورة', kite: 'طيارة ورق',
  'baseball bat': 'مضرب', 'baseball glove': 'جوانتي', skateboard: 'سكيت', surfboard: 'لوح', 'tennis racket': 'مضرب تنس',
  bottle: 'إزازة', 'wine glass': 'كاس', cup: 'كوباية', fork: 'شوكة', knife: 'سكينة', spoon: 'معلقة', bowl: 'طبق',
  banana: 'موزة', apple: 'تفاحة', sandwich: 'سندوتش', orange: 'برتقانة', broccoli: 'بروكلي', carrot: 'جزرة',
  'hot dog': 'هوت دوج', pizza: 'بيتزا', donut: 'دونات', cake: 'تورتة', chair: 'كرسي', couch: 'كنبة',
  'potted plant': 'زرعة', bed: 'سرير', 'dining table': 'ترابيزة', toilet: 'تواليت', tv: 'تلفزيون', laptop: 'لابتوب',
  mouse: 'ماوس', remote: 'ريموت', keyboard: 'كيبورد', 'cell phone': 'موبايل', microwave: 'ميكروويف', oven: 'فرن',
  toaster: 'محمصة', sink: 'حوض', refrigerator: 'تلاجة', book: 'كتاب', clock: 'ساعة', vase: 'فازة', scissors: 'مقص',
  'teddy bear': 'دبدوب', 'hair drier': 'سشوار', toothbrush: 'فرشة سنان',
};
const VEHICLES = ['bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train'];
const ANIMALS = ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow'];
const ZONE_PHRASE = { 0: 'قدامك', 1: 'قدامك على اليمين', 7: 'قدامك على الشمال' };

function objectClassOf(label) {
  if (label === 'person') return ObjectClass.Person;
  if (VEHICLES.includes(label)) return ObjectClass.Vehicle;
  if (ANIMALS.includes(label)) return ObjectClass.Animal;
  return ObjectClass.Other;
}

let detector = null;
export function loadDetector() {
  detector ??= (async () => {
    await loadScript(CDN.tf);
    await loadScript(CDN.coco);
    return window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  })().catch((e) => {
    detector = null;
    throw e;
  });
  return detector;
}

// Objects in the picture, each mapped to the zone it lies in (F, FR or FL).
export async function detectObjects(blob) {
  const model = await loadDetector();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const predictions = await model.detect(canvas, 12, 0.45);
  return predictions.map((p) => {
    const [x, , w, h] = p.bbox;
    const bearing = ((x + w / 2) / canvas.width - 0.5) * CAMERA_HFOV_DEG;
    return {
      label: p.class,
      name: LABELS[p.class] ?? p.class,
      score: p.score,
      zone: bearing > 22.5 ? 1 : bearing < -22.5 ? 7 : 0,
      cls: objectClassOf(p.class),
      area: (w * h) / (canvas.width * canvas.height),
    };
  });
}

// One short spoken sentence; the band's own distance is added to the most important object of each zone.
export function describeDetections(detections, telemetry) {
  const zoneDistance = (zone) => {
    const z = telemetry?.zones?.[zone];
    return z?.state === 'obstacle' ? z.mm : null;
  };
  if (!detections.length) {
    const front = zoneDistance(0);
    return front != null
      ? `مش شايف حاجة أعرف اسمها، بس فيه عائق قدامك على بعد ${meters(front)}.`
      : 'مش شايف حاجة واضحة قدامك.';
  }
  const groups = new Map();
  for (const d of detections) {
    const key = `${d.zone}|${d.label}`;
    const g = groups.get(key) ?? { ...d, count: 0 };
    g.count++;
    g.area = Math.max(g.area, d.area);
    groups.set(key, g);
  }
  const weight = (g) => (g.cls === ObjectClass.Person || g.cls === ObjectClass.Vehicle ? 10 : 0) + g.area * 5 + (g.zone === 0 ? 1 : 0);
  const ranked = [...groups.values()].sort((a, b) => weight(b) - weight(a)).slice(0, 4);
  const zonesSaid = new Set();
  const parts = ranked.map((g) => {
    let what = g.name;
    if (g.label === 'person') what = g.count === 1 ? 'شخص' : g.count === 2 ? 'شخصين' : `${g.count} أشخاص`;
    else if (g.count > 1) what = `أكتر من ${g.name}`;
    let distance = '';
    if (!zonesSaid.has(g.zone) && zoneDistance(g.zone) != null) distance = `، على بعد ${meters(zoneDistance(g.zone))}`;
    zonesSaid.add(g.zone);
    return `${what} ${ZONE_PHRASE[g.zone]}${distance}`;
  });
  return `${parts.join('. ')}.`;
}

// Tags sent to the band so it can vibrate person / vehicle rhythms in that zone.
export function zoneTags(detections) {
  const best = new Map();
  for (const d of detections) {
    if (d.cls === ObjectClass.Other) continue;
    const prev = best.get(d.zone);
    if (!prev || d.cls < prev.cls) best.set(d.zone, d);  // people first, then vehicles
  }
  return [...best.values()].map((d) => ({ zone: d.zone, cls: d.cls }));
}

let ocrWorker = null;
export async function readTextOffline(blob) {
  await loadScript(CDN.tesseract);
  ocrWorker ??= await window.Tesseract.createWorker('ara+eng');
  const { data } = await ocrWorker.recognize(blob);
  return data.text.replace(/[ \t]+\n/g, '\n').trim();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const SCENE_PROMPT = `You describe photos for a blind pedestrian in Egypt. The camera sits on their forehead, so the centre of the image is straight ahead.
Answer in Egyptian Arabic, in at most three short spoken sentences (no lists, no markdown):
first anything in their walking path (obstacles, steps, holes, doors, vehicles) with its direction (قدامك / على يمينك / على شمالك) and rough distance; then people and anything useful nearby such as doors, stairs, shop signs or readable text.
If the photo is too dark or blurry to help, say so in one sentence. Do not comment on the photo itself.
Latency-sensitive; begin your visible answer immediately.`;

const READ_PROMPT = `Read out all the text visible in this photo for a blind user, in its original language (Arabic or English), in natural reading order.
Output only the text as plain sentences, without markdown. If there is no readable text, reply exactly: مفيش كلام واضح في الصورة.
Latency-sensitive; begin your visible answer immediately.`;

// Scene description or text reading by Claude. `sensors` is the band's current distances, as text.
export async function askClaude(blob, { apiKey, mode = 'scene', sensors = '' }) {
  const { default: Anthropic } = await import(CDN.anthropic);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = await blobToBase64(blob);
  const question = mode === 'read'
    ? 'اقرا الكلام اللي في الصورة.'
    : `إيه اللي قدامي؟${sensors ? `\nحساسات المسافة في البندانة دلوقتي: ${sensors}` : ''}`;
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: mode === 'read' ? READ_PROMPT : SCENE_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: question },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return 'مش هقدر أوصف الصورة دي.';
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return text || 'مجاليش رد.';
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('مفتاح Claude غلط. راجعه في الإعدادات.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('طلبات كتير ورا بعض. استنى شوية وجرب تاني.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('مفيش إنترنت دلوقتي.');
    if (err instanceof Anthropic.APIError) throw new Error('خدمة الوصف فيها مشكلة دلوقتي.');
    throw err;
  }
}

export function sensorsSummary(telemetry) {
  if (!telemetry) return '';
  return telemetry.zones
    .map((z, i) => (z.state === 'obstacle' ? `${ZONES[i].name} ${(z.mm / 1000).toFixed(1)} متر` : null))
    .filter(Boolean)
    .join('، ');
}
