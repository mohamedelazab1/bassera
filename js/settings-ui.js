// The band-settings form: every field of the 54-byte settings blob.
import { PRESETS, PROFILE_NAMES, Profile, ZONES, sanitize } from './protocol.js';

const TOGGLES = [
  ['approachAlerts', 'تنبيه أقوى لما حاجة تقرب منك بسرعة'],
  ['groundFilter', 'تجاهل الأرض لما توطي راسك'],
  ['fallDetection', 'اكتشاف الوقوع وطلب المساعدة'],
  ['calmWhenStanding', 'هدّي التنبيهات البعيدة وانت واقف'],
  ['quiet', 'وضع الهدوء: العوائق القريبة بس'],
  ['tactons', 'نبضات مختلفة للأشخاص والعربيات (مع الكاميرا)'],
];

const metres = (mm) => `${(mm / 1000).toFixed(1)} م`;

export function renderSettingsForm(form, s) {
  const profiles = [Profile.Indoor, Profile.Outdoor, Profile.Crowd];
  if (s.profile === Profile.Custom) profiles.push(Profile.Custom);
  form.innerHTML = `
    <fieldset>
      <legend>الوضع</legend>
      <div class="segmented">
        ${profiles.map((p) => `<label><input type="radio" name="profile" value="${p}" ${s.profile === p ? 'checked' : ''}> ${PROFILE_NAMES[p]}</label>`).join('')}
      </div>
      <p class="hint">داخلي: مدى أقصر جوه البيوت والمحلات. شارع: مدى أطول. زحمة: أقل عدد اهتزازات في نفس الوقت.</p>
    </fieldset>
    <fieldset>
      <legend>الاهتزاز</legend>
      <label class="field">قوة الاهتزاز <output>${s.intensityPct}%</output>
        <input type="range" name="intensityPct" min="20" max="100" step="5" value="${s.intensityPct}"></label>
      <label class="field">أقصى عدد اتجاهات تهتز مع بعض <output>${s.maxActiveZones}</output>
        <input type="range" name="maxActiveZones" min="1" max="8" step="1" value="${s.maxActiveZones}"></label>
      <div class="segmented" role="radiogroup" aria-label="طريقة تمثيل المسافة">
        <label><input type="radio" name="encoding" value="0" ${s.encoding === 0 ? 'checked' : ''}> ٤ مستويات (أسهل في التعلم)</label>
        <label><input type="radio" name="encoding" value="1" ${s.encoding === 1 ? 'checked' : ''}> متدرّج (أدق)</label>
      </div>
      ${TOGGLES.map(([key, label]) => `<label class="check"><input type="checkbox" name="${key}" ${s[key] ? 'checked' : ''}> ${label}</label>`).join('')}
    </fieldset>
    <fieldset>
      <legend>المدى لكل اتجاه</legend>
      <p class="hint">العائق أبعد من "المدى" مش هيهتز. أقرب من "اهتزاز مستمر" يبقى خطر قريب جداً.</p>
      ${ZONES.map((z, i) => `
        <div class="zone-row">
          <label class="check"><input type="checkbox" name="z${i}-enabled" ${s.zones[i].enabled ? 'checked' : ''}> ${z.name}</label>
          <label class="field">المدى <output>${metres(s.zones[i].maxMm)}</output>
            <input type="range" name="z${i}-max" min="300" max="4000" step="100" value="${s.zones[i].maxMm}"></label>
          <label class="field">اهتزاز مستمر تحت <output>${metres(s.zones[i].criticalMm)}</output>
            <input type="range" name="z${i}-crit" min="100" max="1000" step="50" value="${s.zones[i].criticalMm}"></label>
        </div>`).join('')}
    </fieldset>
    <fieldset>
      <legend>بيانات إضافية</legend>
      <label class="field">طولك بالسنتي (عشان تجاهل الأرض)
        <input type="number" name="userHeightCm" min="100" max="220" inputmode="numeric" value="${s.userHeightCm}"></label>
      <label class="field">حرارة الجو تقريباً (بتظبط قياس الموجات الصوتية)
        <input type="number" name="airTempC" min="-10" max="55" inputmode="numeric" value="${s.airTempC}"></label>
      <label class="field">اقفل الكاميرا بعد كام ثانية من غير استخدام (٠ = أبداً)
        <input type="number" name="cameraTimeoutS" min="0" max="255" inputmode="numeric" value="${s.cameraTimeoutS}"></label>
    </fieldset>`;

  form.querySelectorAll('input[type=range]').forEach((r) => {
    r.addEventListener('input', () => {
      const out = r.parentElement.querySelector('output');
      if (!out) return;
      if (r.name.startsWith('z')) out.textContent = metres(Number(r.value));
      else out.textContent = r.name === 'intensityPct' ? `${r.value}%` : r.value;
    });
  });
}

export function readSettingsForm(form, base) {
  const f = new FormData(form);
  const s = structuredClone(base);
  s.profile = Number(f.get('profile') ?? s.profile);
  s.encoding = Number(f.get('encoding') ?? s.encoding);
  s.intensityPct = Number(f.get('intensityPct'));
  s.maxActiveZones = Number(f.get('maxActiveZones'));
  for (const [key] of TOGGLES) s[key] = f.get(key) === 'on';
  s.userHeightCm = Number(f.get('userHeightCm'));
  s.airTempC = Number(f.get('airTempC'));
  s.cameraTimeoutS = Number(f.get('cameraTimeoutS'));
  s.zones = s.zones.map((_, i) => ({
    enabled: f.get(`z${i}-enabled`) === 'on',
    maxMm: Number(f.get(`z${i}-max`)),
    criticalMm: Number(f.get(`z${i}-crit`)),
  }));
  sanitize(s);
  // Ranges tuned by hand no longer match the chosen preset.
  const preset = PRESETS[s.profile];
  if (preset) {
    const matches = s.maxActiveZones === preset.maxActiveZones &&
      s.zones.every((z, i) => z.maxMm === preset.maxMm[i] && z.criticalMm === preset.criticalMm[i]);
    if (!matches) s.profile = Profile.Custom;
  }
  return s;
}
