// Eyeon phone app - wires the band, the cameras, speech, training, SOS and settings together.
import { BandCamera, FrameSize, PhoneCamera } from './camera.js';
import { DemoDevice, EyeonDevice } from './device.js';
import { Command, Event, Gesture, LEVEL_NAMES, PROFILE_NAMES, ZONES, u16 } from './protocol.js';
import { drawRadar, zoneLines } from './radar.js';
import { readSettingsForm, renderSettingsForm } from './settings-ui.js';
import { Sos } from './sos.js';
import {
  canListen, initSpeech, listen, matchCommand, say, secondsAr, setSpeechMode, setSpeechRate, speechMode, speechRate,
} from './speech.js';
import { load, save } from './store.js';
import { LESSONS, Trainer } from './training.js';
import {
  askClaude, describeDetections, detectObjects, readTextOffline, sensorsSummary, zoneTags,
} from './vision.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = {
  device: null,
  camera: new BandCamera(() => app.device),
  phoneCamera: new PhoneCamera(),
  telemetry: null,
  status: null,
  settings: null,
  busy: false,
  highlight: { mask: 0, until: 0 },
  drawQueued: false,
  lastListUpdate: 0,
  wakeLock: null,
};
const sos = new Sos(() => app.device);
const trainer = new Trainer(() => app.device);

// ---------------------------------------------------------------- tabs

const TABS = ['home', 'radar', 'training', 'sos', 'settings'];

function showTab(name, { focus = true } = {}) {
  for (const t of TABS) {
    const selected = t === name;
    const btn = $(`#tab-btn-${t}`);
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    $(`#tab-${t}`).hidden = !selected;
  }
  if (focus) $(`#tab-${name} h2`)?.focus();
  if (name === 'radar') queueDraw();
}

function initTabs() {
  TABS.forEach((t, i) => {
    const btn = $(`#tab-btn-${t}`);
    btn.addEventListener('click', () => showTab(t));
    btn.addEventListener('keydown', (e) => {
      // Arrow keys move between tabs (reversed in RTL).
      const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
      if (!step) return;
      const next = TABS[(i + step + TABS.length) % TABS.length];
      showTab(next, { focus: false });
      $(`#tab-btn-${next}`).focus();
    });
  });
}

// ---------------------------------------------------------------- connection

function wire(device) {
  device.addEventListener('connection', () => renderConnection());
  device.addEventListener('telemetry', (e) => onTelemetry(e.detail));
  device.addEventListener('status', (e) => {
    app.status = e.detail;
    renderConnection();
  });
  device.addEventListener('deviceevent', (e) => onDeviceEvent(e.detail));
  device.addEventListener('settings', (e) => onSettings(e.detail));
  device.addEventListener('pattern', (e) => flash(e.detail.mask, e.detail.durationMs));
}

function replaceDevice(device) {
  app.device?.disconnect();
  app.device = device;
  app.telemetry = null;
  app.status = null;
  wire(device);
}

async function connectBand() {
  if (!EyeonDevice.supported()) {
    say('المتصفح ده مش بيدعم البلوتوث. استخدم Chrome على أندرويد.');
    return;
  }
  const device = new EyeonDevice();
  try {
    await device.connect();
    replaceDevice(device);
    renderConnection();
    onSettings(device.settings);
    say(`${device.name} متصلة.`);
  } catch (e) {
    if (e.name !== 'NotFoundError') say(`مقدرتش أوصل للبندانة. ${e.message}`);
  }
}

async function startDemo() {
  replaceDevice(new DemoDevice());
  await app.device.connect();
  renderConnection();
  say('شغّال تجريبي: ماشي في طرقة فيها عمود وناس وكرسي. شوف الرادار أو جرب الأزرار.');
}

async function connectCamera() {
  if (!BandCamera.supported()) {
    say('البلوتوث مش متاح هنا. هستخدم كاميرا الموبايل.');
    return;
  }
  if (!app.device?.connected || app.device.kind !== 'ble') {
    say('وصّل البندانة الأول، هي اللي بتشغّل الكاميرا.');
    return;
  }
  try {
    await app.camera.connect();
    say('الكاميرا اتوصلت.');
  } catch (e) {
    if (e.name !== 'NotFoundError') say(`مقدرتش أوصل للكاميرا. ${e.message}`);
  }
  renderConnection();
}

function renderConnection() {
  const d = app.device;
  const battery = app.telemetry?.battery ?? app.status?.battery;
  let band = 'البندانة: مش متوصلة';
  if (d?.connected) {
    band = `البندانة: متصلة - ${d.name}`;
    if (battery != null) band += ` - البطارية ${battery}%`;
  }
  $('#band-status').textContent = band;
  $('#top-status').textContent = d?.connected
    ? `${d.kind === 'demo' ? 'تجريبي' : 'متصلة'}${battery != null ? ` - ${battery}%` : ''}`
    : 'البندانة مش متوصلة';
  $('#camera-status').textContent = app.camera.connected
    ? 'الكاميرا: متصلة (كاميرا البندانة)'
    : 'الكاميرا: مش متوصلة (هستخدم كاميرا الموبايل)';
  $('#btn-connect').textContent = d?.connected && d.kind === 'ble' ? 'افصل البندانة' : 'وصّل البندانة';
  $('#btn-demo').textContent = d?.connected && d.kind === 'demo' ? 'وقّف التجربة' : 'تجربة من غير جهاز';
  const s = d?.connected ? d.settings : null;
  $('#btn-quiet').setAttribute('aria-pressed', String(!!s?.quiet));
  $('#btn-pause').setAttribute('aria-pressed', String(!!app.telemetry?.flags?.paused));
  for (const id of ['#btn-settings-save', '#btn-settings-reload']) $(id).disabled = !d?.connected;
  $('#settings-note').hidden = !!d?.connected;
  if (app.status) {
    const st = app.status;
    $('#about').textContent = `البندانة: إصدار ${st.firmware}، نسخة ${st.variant === 'plus' ? 'Plus' : 'Lite'}، ` +
      `حساسات ليزر شغالة ${st.tofCount}، حساس الحركة ${st.imuOk ? 'شغال' : 'مش موجود'}.`;
  }
}

// ---------------------------------------------------------------- telemetry and radar

function onTelemetry(t) {
  const first = !app.telemetry;
  app.telemetry = t;
  if (first) renderConnection();
  queueDraw();
  const now = performance.now();
  if (now - app.lastListUpdate > 1000) {
    app.lastListUpdate = now;
    renderZoneList();
    renderConnection();
  }
}

function queueDraw() {
  if (app.drawQueued || $('#tab-radar').hidden) return;
  app.drawQueued = true;
  requestAnimationFrame(() => {
    app.drawQueued = false;
    const mask = performance.now() < app.highlight.until ? app.highlight.mask : 0;
    drawRadar($('#radar'), app.telemetry, { highlightMask: mask });
  });
}

function renderZoneList() {
  const list = $('#zone-list');
  const lines = zoneLines(app.telemetry);
  list.replaceChildren(...lines.map((text, i) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.level = String(app.telemetry?.zones?.[i]?.level ?? 0);
    return li;
  }));
  const t = app.telemetry;
  if (t) {
    const motion = t.flags.walking ? 'ماشي' : 'واقف';
    $('#radar-meta').textContent = `${motion} - ميل الراس ${t.pitch} درجة${t.flags.quiet ? ' - وضع الهدوء' : ''}${t.flags.paused ? ' - الاهتزاز موقوف مؤقتاً' : ''}`;
  }
}

function flash(mask, durationMs) {
  app.highlight = { mask, until: performance.now() + durationMs };
  queueDraw();
  setTimeout(queueDraw, durationMs + 50);
}

// ---------------------------------------------------------------- recognition

async function takePicture(purpose) {
  if (app.camera.connected) {
    return app.camera.capture(purpose === 'read'
      ? { size: FrameSize.XGA, quality: 10 }
      : { size: FrameSize.VGA, quality: 12 });
  }
  if (PhoneCamera.supported()) return app.phoneCamera.capture();
  throw new Error('no-camera');
}

function showPreview(blob) {
  const img = $('#preview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.dataset.url = URL.createObjectURL(blob);
  img.src = img.dataset.url;
  img.hidden = false;
}

function errorText(e) {
  const msg = String(e?.message ?? e);
  if (e?.name === 'NotAllowedError') return 'محتاج إذن الكاميرا. اسمح بيه من إعدادات المتصفح.';
  if (msg === 'no-camera' || msg === 'camera-not-connected') return 'مفيش كاميرا متاحة.';
  if (msg === 'download-failed') return 'مقدرتش أحمّل ملفات التعرف. أول مرة لازم يكون فيه إنترنت.';
  if (msg === 'camera-timeout' || msg === 'camera-incomplete') return 'الكاميرا مردتش. جرب تاني.';
  if (msg === 'camera-busy') return 'لسه بصوّر، استنى ثانية.';
  if (msg === 'not-connected') return 'البندانة مش متوصلة.';
  return msg;
}

async function withBusy(fn) {
  if (app.busy) {
    say('لسه شغال على الطلب اللي فات.');
    return;
  }
  app.busy = true;
  $('.actions').classList.add('busy');
  try {
    await fn();
  } catch (e) {
    say(errorText(e), { interrupt: true });
  } finally {
    app.busy = false;
    $('.actions').classList.remove('busy');
  }
}

function sendTags(detections) {
  if (!app.device?.connected) return;
  for (const t of zoneTags(detections)) app.device.send(Command.ZoneTag, t.zone, t.cls, u16(4000)).catch(() => {});
}

const describe = () => withBusy(async () => {
  say('ثانية، بشوف...', { interrupt: true });
  const picture = await takePicture('scene');
  showPreview(picture);
  const key = load('claudeKey', '');
  if (key && navigator.onLine) {
    try {
      say(await askClaude(picture, { apiKey: key, mode: 'scene', sensors: sensorsSummary(app.telemetry) }), { interrupt: true });
      return;
    } catch (e) {
      say(`${errorText(e)} هستخدم التعرف اللي على الموبايل.`, { interrupt: true });
    }
  }
  const detections = await detectObjects(picture);
  sendTags(detections);
  say(describeDetections(detections, app.telemetry), { interrupt: true });
});

const readText = () => withBusy(async () => {
  say('ثبّت راسك على الورقة أو اليافطة...', { interrupt: true });
  const picture = await takePicture('read');
  showPreview(picture);
  const key = load('claudeKey', '');
  if (key && navigator.onLine) {
    try {
      say(await askClaude(picture, { apiKey: key, mode: 'read' }), { interrupt: true });
      return;
    } catch (e) {
      say(`${errorText(e)} هقرا بالموبايل.`, { interrupt: true });
    }
  }
  if (!load('ocrReady', false)) say('أول مرة بحمّل ملفات القراءة، ممكن تاخد دقيقة.');
  const text = await readTextOffline(picture);
  save('ocrReady', true);
  say(text || 'مفيش كلام واضح في الصورة.', { interrupt: true });
});

// ---------------------------------------------------------------- quick actions

function speakBattery() {
  const pct = app.telemetry?.battery ?? app.status?.battery;
  if (pct == null) {
    say('البندانة مش متوصلة.');
    return;
  }
  say(`البطارية ${pct} في المية.`);
  app.device?.send(Command.BatteryReport).catch(() => {});
}

function speakStatus() {
  const t = app.telemetry;
  if (!t) {
    say('البندانة مش متوصلة.');
    return;
  }
  const near = t.zones
    .map((z, i) => (z.state === 'obstacle' && z.level ? `${ZONES[i].name} ${LEVEL_NAMES[z.level]}` : null))
    .filter(Boolean);
  const broken = t.zones.map((z, i) => (z.state === 'fault' ? ZONES[i].name : null)).filter(Boolean);
  let text = near.length ? `فيه عوائق: ${near.join('، ')}.` : 'مفيش عوائق قريبة.';
  if (broken.length) text += ` الحساسات دي مش شغالة: ${broken.join('، ')}.`;
  say(text);
}

async function sendOrExplain(...args) {
  if (!app.device?.connected) {
    say('البندانة مش متوصلة.');
    return false;
  }
  await app.device.send(...args).catch((e) => say(errorText(e)));
  return true;
}

const setQuiet = (on) => sendOrExplain(Command.SetQuiet, on ? 1 : 0);
const setProfile = (p) => sendOrExplain(Command.SetProfile, p);

async function togglePause() {
  const paused = !!app.telemetry?.flags?.paused;
  if (await sendOrExplain(Command.Pause, u16(paused ? 0 : 300))) {
    say(paused
      ? 'رجع الاهتزاز.'
      : 'وقّفت الاهتزاز ٥ دقايق. الخطر القريب جداً لسه هيهتز.');
  }
}

const ACTIONS = {
  describe,
  read: readText,
  battery: speakBattery,
  sos: () => sos.start('voice', 10),
  pause: () => sendOrExplain(Command.Pause, u16(300)).then((ok) => ok && say('وقّفت الاهتزاز ٥ دقايق.')),
  resume: () => sendOrExplain(Command.Pause, u16(0)).then((ok) => ok && say('رجع الاهتزاز.')),
  quietOn: () => setQuiet(true),
  quietOff: () => setQuiet(false),
  indoor: () => setProfile(0),
  outdoor: () => setProfile(1),
  crowd: () => setProfile(2),
  findMe: () => sendOrExplain(Command.FindMe),
  status: speakStatus,
};

async function voiceCommand() {
  if (!canListen()) {
    say('الأوامر الصوتية مش متاحة في المتصفح ده.');
    return;
  }
  await say('اتكلم دلوقتي.', { interrupt: true });
  try {
    const phrases = await listen();
    const action = matchCommand(phrases);
    if (action) await ACTIONS[action]();
    else say(phrases.length ? `سمعت: ${phrases[0]}. مفهمتش الأمر.` : 'مسمعتش حاجة.');
  } catch (e) {
    say(e.message === 'not-allowed' ? 'محتاج إذن الميكروفون.' : 'مقدرتش أسمع. جرب تاني.');
  }
}

// ---------------------------------------------------------------- events from the band

function onDeviceEvent({ type, args }) {
  switch (type) {
    case Event.Hello:
      say(`${app.device?.name ?? 'البندانة'} متصلة.`);
      break;
    case Event.Button:
      if (args[0] === Gesture.Single) speakBattery();
      else if (args[0] === Gesture.Double) describe();
      break;
    case Event.SosRequest:
      sos.start('button', 10);
      break;
    case Event.FallDetected:
      sos.start('fall', 30);
      break;
    case Event.SosCancel:
      sos.cancel({ fromBand: true });
      break;
    case Event.BatteryLow:
      say(`البطارية ضعيفة، فاضل ${args[0]} في المية.`);
      break;
    case Event.BatteryCritical:
      say('البطارية هتخلص. اشحن البندانة دلوقتي.', { interrupt: true });
      break;
    case Event.ZoneFault: {
      const names = ZONES.filter((_, i) => args[0] & (1 << i)).map((z) => z.name);
      if (names.length) say(`حساس ${names.join(' و ')} مش شغال.`);
      break;
    }
    case Event.SensingFault:
      say(args[0] ? 'تحذير: الحساسات وقفت. متعتمدش على البندانة لحد ما ترجع.' : 'الحساسات رجعت تشتغل.',
        { interrupt: !!args[0] });
      break;
    case Event.ProfileChanged:
      say(`وضع ${PROFILE_NAMES[args[0]] ?? ''}.`);
      app.device?.readSettings?.().catch(() => {});
      break;
    case Event.QuietChanged:
      say(args[0] ? 'وضع الهدوء: هتحس بالعوائق القريبة بس.' : 'رجعت التنبيهات العادية.');
      app.device?.readSettings?.().catch(() => {});
      break;
    case Event.Calibration:
      if (args[0] === 1) say('تمام. دلوقتي وطّي راسك لتحت شوية ودوس معايرة ٢.');
      else say(args[1] ? 'المعايرة تمت.' : 'المعايرة منفعتش. وطّي راسك أكتر وجرب تاني.');
      break;
    case Event.CameraPower:
      renderConnection();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- SOS

let sosRendered = 'idle';

function renderSos() {
  const panel = $('#sos-panel');
  panel.hidden = sos.state === 'idle';
  $('#sos-countdown').textContent = sos.state === 'countdown'
    ? `هتتبعت بعد ${secondsAr(sos.remaining)}`
    : sos.state === 'sent' ? 'اتفتحت الرسالة. اتأكد إنها اتبعتت.' : 'الرسالة جاهزة';
  $('#sos-location').textContent = sos.position ? 'المكان: اتحدد' : 'بحدد مكانك...';
  // Rebuild the buttons only when the step changes, so screen-reader focus stays put during the countdown.
  if (sos.state === sosRendered) return;
  sosRendered = sos.state;
  if (panel.hidden) return;
  const buttons = [];
  const add = (label, handler, cls = '') => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', handler);
    buttons.push(b);
  };
  if (sos.state === 'countdown') {
    add('إلغاء - أنا كويس', () => sos.cancel(), 'primary');
    add('ابعت دلوقتي', () => sos.ready());
  } else {
    for (const c of sos.contacts) {
      add(`ابعت واتساب لـ ${c.name}`, () => sos.send(c, 'whatsapp'), 'primary');
      add(`ابعت رسالة SMS لـ ${c.name}`, () => sos.send(c, 'sms'));
      add(`اتصل بـ ${c.name}`, () => sos.send(c, 'call'));
    }
    if (!sos.contacts.length) add('ضيف رقم طوارئ', () => { sos.close(); showTab('sos'); }, 'primary');
    add('قفل', () => sos.close());
  }
  $('#sos-actions').replaceChildren(...buttons);
  buttons[0]?.focus();
}

function renderContacts() {
  const list = $('#contact-list');
  list.replaceChildren(...sos.contacts.map((c, i) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${c.name} - ${c.phone}`;
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = `امسح ${c.name}`;
    del.addEventListener('click', () => {
      sos.setContacts(sos.contacts.filter((_, j) => j !== i));
      renderContacts();
    });
    li.append(label, del);
    return li;
  }));
  if (!sos.contacts.length) {
    const li = document.createElement('li');
    li.textContent = 'مفيش أرقام لسه. ضيف رقم واحد على الأقل.';
    list.append(li);
  }
}

// ---------------------------------------------------------------- training

function initTraining() {
  $('#lesson-list').replaceChildren(...LESSONS.map((lesson, i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = lesson.title;
    b.addEventListener('click', async () => {
      if (!app.device?.connected) {
        say('وصّل البندانة أو شغّل التجربة الأول.');
        return;
      }
      trainer.stop();
      await trainer.runLesson(i).catch((e) => say(errorText(e)));
    });
    return b;
  }));
  $('#btn-lesson-stop').addEventListener('click', () => trainer.stop());
  trainer.addEventListener('play', (e) => flash(e.detail.mask, e.detail.ms));

  // Compass, laid out physically: front-left, front, front-right / left, -, right / back...
  const layout = [7, 0, 1, 6, -1, 2, 5, 4, 3];
  let chosenZone = null;
  const zoneButtons = layout.map((zone) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = zone < 0 ? 'btn center' : 'btn';
    b.textContent = zone < 0 ? '' : ZONES[zone].name;
    if (zone < 0) b.tabIndex = -1;
    b.addEventListener('click', () => {
      if (zone < 0) return;
      chosenZone = zone;
      zoneButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      say(`${ZONES[zone].name}. اختار المسافة.`);
    });
    return b;
  });
  $('#quiz-zones').replaceChildren(...zoneButtons);

  const levelButtons = [1, 2, 3, 4].map((level) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = LEVEL_NAMES[level];
    b.addEventListener('click', () => {
      if (!trainer.question) {
        say('دوس سؤال جديد الأول.');
        return;
      }
      if (chosenZone == null) {
        say('اختار الاتجاه الأول.');
        return;
      }
      const r = trainer.answer(chosenZone, level);
      const right = `${ZONES[r.expected.zone].name}، ${LEVEL_NAMES[r.expected.level]}`;
      if (r.zoneOk && r.levelOk) say('صح! برافو.');
      else if (r.zoneOk) say(`الاتجاه صح، بس المسافة كانت ${LEVEL_NAMES[r.expected.level]}.`);
      else if (r.levelOk) say(`المسافة صح، بس الاتجاه كان ${ZONES[r.expected.zone].name}.`);
      else say(`الإجابة الصح: ${right}.`);
      chosenZone = null;
      zoneButtons.forEach((x) => x.removeAttribute('aria-pressed'));
      renderScore();
    });
    return b;
  });
  $('#quiz-levels').replaceChildren(...levelButtons);

  $('#btn-quiz-new').addEventListener('click', async () => {
    if (!app.device?.connected) {
      say('وصّل البندانة أو شغّل التجربة الأول.');
      return;
    }
    trainer.newQuestion();
    say('حس بالاهتزاز.', { interrupt: true });
    await sleep(900);
    await trainer.askQuestion().catch((e) => say(errorText(e)));
    $('#quiz-prompt').textContent = 'اختار الاتجاه، وبعدين المسافة.';
  });
  $('#btn-quiz-replay').addEventListener('click', () => {
    if (trainer.question) trainer.askQuestion().catch((e) => say(errorText(e)));
  });
  $('#btn-quiz-reset').addEventListener('click', () => {
    trainer.resetStats();
    renderScore();
  });
  renderScore();
}

function renderScore() {
  const s = trainer.stats;
  $('#quiz-score').textContent = s.tries
    ? `النتيجة: ${s.correct} صح من ${s.tries} (${Math.round((100 * s.correct) / s.tries)}%)`
    : 'لسه مفيش أسئلة.';
}

// ---------------------------------------------------------------- settings

let settingsDirty = false;

function onSettings(s) {
  if (!s) return;
  app.settings = s;
  renderConnection();
  if (!settingsDirty) renderSettingsForm($('#settings-form'), s);
}

function initSettings() {
  const form = $('#settings-form');
  form.addEventListener('input', () => (settingsDirty = true));
  form.addEventListener('change', async (e) => {
    if (e.target.name === 'profile' && Number(e.target.value) !== 3) {
      settingsDirty = false;
      await setProfile(Number(e.target.value));
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#btn-settings-save').addEventListener('click', async () => {
    if (!app.device?.connected || !app.settings) return;
    const s = readSettingsForm(form, app.settings);
    try {
      settingsDirty = false;
      await app.device.writeSettings(s);
      say('اتحفظت الإعدادات على البندانة.');
    } catch (e) {
      say(`محصلش حفظ. ${errorText(e)}`);
    }
  });
  $('#btn-settings-reload').addEventListener('click', async () => {
    settingsDirty = false;
    await app.device?.readSettings().catch(() => {});
  });

  $('#btn-motor-test').addEventListener('click', () => sendOrExplain(Command.MotorTest));
  $('#btn-find').addEventListener('click', () => sendOrExplain(Command.FindMe));
  $('#btn-cal-1').addEventListener('click', () => sendOrExplain(Command.CalibrateUpright));
  $('#btn-cal-2').addEventListener('click', () => sendOrExplain(Command.CalibrateNod));
  $('#btn-factory').addEventListener('click', () => {
    if (confirm('أرجّع كل إعدادات البندانة لإعدادات المصنع؟')) sendOrExplain(Command.FactoryReset);
  });

  const mode = $('#speech-mode');
  mode.value = speechMode();
  mode.addEventListener('change', () => setSpeechMode(mode.value));
  const rate = $('#speech-rate');
  rate.value = String(speechRate());
  $('#rate-out').textContent = `${speechRate()}x`;
  rate.addEventListener('input', () => {
    setSpeechRate(Number(rate.value));
    $('#rate-out').textContent = `${rate.value}x`;
  });
  rate.addEventListener('change', () => say('دي سرعة الكلام الجديدة.', { interrupt: true }));

  const awake = $('#keep-awake');
  awake.checked = load('keepAwake', false);
  awake.addEventListener('change', () => {
    save('keepAwake', awake.checked);
    keepAwake(awake.checked);
  });
  const vib = $('#demo-vibration');
  vib.checked = load('demoVibration', true);
  vib.addEventListener('change', () => {
    save('demoVibration', vib.checked);
    if (app.device?.kind === 'demo') app.device.setPhoneVibration(vib.checked);
  });

  const key = $('#claude-key');
  key.value = load('claudeKey', '');
  $('#btn-key-save').addEventListener('click', () => {
    save('claudeKey', key.value.trim());
    say(key.value.trim() ? 'اتحفظ المفتاح. الوصف هيستخدم Claude لما يكون فيه إنترنت.' : 'اتمسح المفتاح.');
  });
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) app.wakeLock = await navigator.wakeLock.request('screen');
    else await app.wakeLock?.release();
  } catch {
    // Not available or refused - the setting simply has no effect.
  }
}

// ---------------------------------------------------------------- start-up

function initHome() {
  $('#btn-connect').addEventListener('click', () => {
    if (app.device?.connected && app.device.kind === 'ble') {
      app.device.disconnect();
      renderConnection();
    } else {
      connectBand();
    }
  });
  $('#btn-demo').addEventListener('click', () => {
    if (app.device?.connected && app.device.kind === 'demo') {
      app.device.disconnect();
      renderConnection();
    } else {
      startDemo();
    }
  });
  $('#btn-camera').addEventListener('click', connectCamera);
  $('#btn-describe').addEventListener('click', describe);
  $('#btn-read').addEventListener('click', readText);
  $('#btn-voice').addEventListener('click', voiceCommand);
  $('#btn-battery').addEventListener('click', speakBattery);
  $('#btn-quiet').addEventListener('click', () => setQuiet(!app.device?.settings?.quiet));
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-sos').addEventListener('click', () => sos.start('app', 10));
  $('#ble-warning').hidden = EyeonDevice.supported();
  app.camera.addEventListener('connection', renderConnection);
}

function initSos() {
  sos.addEventListener('state', renderSos);
  $('#contact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    sos.setContacts([...sos.contacts, { name: String(f.get('name')).trim(), phone: String(f.get('phone')).trim() }]);
    e.target.reset();
    renderContacts();
    say('اتضاف الرقم.');
  });
  const msg = $('#sos-message');
  msg.value = sos.message;
  msg.addEventListener('change', () => sos.setMessage(msg.value.trim() || 'محتاج مساعدة دلوقتي. ده مكاني:'));
  $('#btn-sos-test').addEventListener('click', () => sos.start('app', 10));
  renderContacts();
}

async function reconnect() {
  try {
    const device = new EyeonDevice();
    if (EyeonDevice.supported() && await device.reconnectKnown()) {
      replaceDevice(device);
      renderConnection();
      onSettings(device.settings);
      await app.camera.reconnectKnown().catch(() => false);
      renderConnection();
    }
  } catch {
    // The band is off or out of range: the user can connect with the button.
  }
}

function init() {
  initSpeech({ live: $('#live'), log: $('#last-message') });
  initTabs();
  initHome();
  initSos();
  initTraining();
  initSettings();
  renderConnection();
  if (load('keepAwake', false)) keepAwake(true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && load('keepAwake', false)) keepAwake(true);
  });
  window.addEventListener('resize', queueDraw);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  reconnect();
}

init();
