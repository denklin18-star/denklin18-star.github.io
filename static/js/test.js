'use strict';

/* ============================================================
   Лови Ритм — логика теста (механика неизменна)

   120 BPM, 37 ударов:
     3  — слушаем
     7  — тапаем вместе с кликом
     7  — клик затихает (отсчёт 5…1)
     15 — тишина, держим темп сами
     5  — финиш (отсчёт 5…1)
   Зачётные: 20 ударов (тишина + финиш), максимум 1000 баллов.
   ============================================================ */

(() => {

const BPM = 120;
const BEAT = 60 / BPM;              // 0.5 c
const BEAT_MS = BEAT * 1000;        // 500 мс
const MAX_PER_BEAT = 50;
const TOLERANCE_MS = 100;
const SCORED = 20;

const PHASES = [
  { beats: 3 },
  { beats: 7 },
  { beats: 7 },
  { beats: 15 },
  { beats: 5 },
];

const PHASE_START = PHASES.reduce((acc, p, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + PHASES[i - 1].beats);
  return acc;
}, []);

const TOTAL_BEATS = PHASES.reduce((sum, p) => sum + p.beats, 0); // 37
const SOLO_START = PHASE_START[3];                                // 17
const FADE_MS = 1600;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v, digits = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(digits));
const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ------------------------------------------------------------ */
/*  Состояние                                                   */
/* ------------------------------------------------------------ */

const state = {
  mode: 'idle',        // idle | running | done
  ctx: null,
  master: null,
  track: null,
  startAt: 0,
  scheduled: 0,
  beats: [],
  vis: [],
  schedTimer: null,
  endTimer: null,
  raf: 0,
  taps: [],
  tapResiduals: [],
  tapOffset: 0,        // постоянное запаздывание/опережение в кликовой фазе
  score: null,
  input: 'tap',        // tap | voice
};

let starting = false;
let startToken = 0;

/* ------------------------------------------------------------ */
/*  Экраны                                                      */
/* ------------------------------------------------------------ */

function showScreen(name) {
  $('screenStart').hidden = name !== 'start';
  $('screenTest').hidden = name !== 'test';
  $('screenResults').hidden = name !== 'results';
  document.body.classList.toggle('is-testing', name === 'test');
  if (name !== 'test') window.scrollTo(0, 0);
}

function setStage(view) {
  $('stageKicker').textContent = view.kicker;
  $('stageMain').textContent = view.main;
  $('stageMain').classList.toggle('is-count', /^\d+$/.test(view.main));
  $('stageSub').textContent = view.sub;
  $('stage').classList.toggle('is-silent', !!view.silent);
  $('stage').classList.toggle('is-alert', !!view.alert);
}

/* ------------------------------------------------------------ */
/*  Аудио                                                       */
/* ------------------------------------------------------------ */

function audioInit() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API не поддерживается');

    state.ctx = new AC({ latencyHint: 'interactive' });
    state.master = state.ctx.createGain();
    state.master.gain.value = 1;
    state.track = state.ctx.createGain();
    state.track.gain.value = 1;

    // Мягкий лимитер перед регулятором затихания: клик звучит
    // заметно громче и плотнее, но не упирается в жёсткий клиппинг.
    // Затухание остаётся линейным, потому что track.gain стоит после.
    state.driveGain = state.ctx.createGain();
    state.driveGain.gain.value = 2.5;
    state.drive = state.ctx.createWaveShaper();
    state.drive.curve = softClipCurve(2);
    state.drive.oversample = '4x';

    state.driveGain.connect(state.drive);
    state.drive.connect(state.track);
    state.track.connect(state.master);
    state.master.connect(state.ctx.destination);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
  return state.ctx;
}

function softClipCurve(drive) {
  const n = 4096;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

function audioNow() {
  const ctx = state.ctx;
  return ctx.currentTime - (ctx.outputLatency || 0);
}

function kick(time, accent) {
  const ctx = state.ctx;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const f0 = accent ? 212 : 180;

  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, time);
  osc.frequency.exponentialRampToValueAtTime(66, time + 0.09);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.75, time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);

  osc.connect(gain).connect(state.driveGain);
  osc.start(time);
  osc.stop(time + 0.24);

  const tick = ctx.createOscillator();
  const tickGain = ctx.createGain();
  tick.type = 'triangle';
  tick.frequency.setValueAtTime(accent ? 1760 : 1480, time);

  tickGain.gain.setValueAtTime(0.0001, time);
  tickGain.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.24, time + 0.002);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);

  tick.connect(tickGain).connect(state.driveGain);
  tick.start(time);
  tick.stop(time + 0.04);
}

/* ------------------------------------------------------------ */
/*  Планировщик (без изменений)                                 */
/* ------------------------------------------------------------ */

function schedule() {
  if (state.mode !== 'running') return;

  const ctx = state.ctx;
  const horizon = ctx.currentTime + 0.2;

  while (state.scheduled < TOTAL_BEATS && state.startAt + state.scheduled * BEAT < horizon) {
    const i = state.scheduled;
    const time = state.startAt + i * BEAT;

    if (i === SOLO_START) {
      const g = state.track.gain;
      g.cancelScheduledValues(time);
      g.setValueAtTime(1, time);
      g.linearRampToValueAtTime(0.0001, time + FADE_MS / 1000);
    }

    kick(time, i % 4 === 0);
    state.beats.push({ i, time });
    state.vis.push(i);
    state.scheduled += 1;
  }

  if (state.scheduled >= TOTAL_BEATS && !state.endTimer) {
    const last = state.beats[state.beats.length - 1].time;
    const wait = Math.max(0, (last - audioNow() + BEAT * 0.9) * 1000);
    state.endTimer = setTimeout(finish, wait);
  }
}

function frame() {
  if (state.mode !== 'running') return;

  const now = audioNow();
  while (state.vis.length && state.startAt + state.vis[0] * BEAT <= now) {
    onBeat(state.vis.shift());
  }

  state.raf = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------ */
/*  Большие подсказки по фазам                                  */
/* ------------------------------------------------------------ */

function centerFor(i) {
  const voice = state.input === 'voice';
  const act = voice ? 'Говорите «та»' : 'Тапайте';
  const actSharp = voice ? 'Резко говорите «та»' : 'Тапайте';

  if (i < 3) {
    return {
      kicker: 'Шаг 1 · Слушаем',
      main: 'Слушайте',
      sub: voice ? 'Запомните темп. Микрофон настраивается…' : 'Запомните темп клика',
    };
  }

  if (i < 10) {
    return {
      kicker: 'Шаг 2 · Вместе с кликом',
      main: `${act} в такт`,
      sub: voice ? 'Резко и отчётливо, одно «та» на каждый клик' : 'Один тап на каждый клик',
    };
  }

  if (i < SOLO_START) {
    const left = SOLO_START - i;
    return {
      kicker: 'Скоро звук выключится',
      main: left <= 5 ? String(left) : `${act} в такт`,
      sub: 'Когда станет тихо — НЕ останавливайтесь, продолжайте в том же темпе',
    };
  }

  if (i < SOLO_START + 3) {
    return {
      kicker: 'Звук выключен',
      main: 'Продолжайте!',
      sub: `${actSharp} в том же ритме, уже без подсказки`,
      silent: true,
      alert: true,
    };
  }

  if (i < PHASE_START[4]) {
    return {
      kicker: 'Шаг 3 · Без музыки',
      main: 'Держите ритм',
      sub: `${actSharp} в том же темпе`,
      silent: true,
    };
  }

  return {
    kicker: 'Финиш',
    main: String(TOTAL_BEATS - i),
    sub: 'Последние удары — темп не меняем',
    silent: true,
  };
}

function onBeat(i) {
  setStage(centerFor(i));
}

function ripple() {
  const el = document.createElement('div');
  el.className = 'tap-ripple';
  $('stage').appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ------------------------------------------------------------ */
/*  Тапы и подсчёт (без изменений)                              */
/* ------------------------------------------------------------ */

function tapAt(t) {
  if (state.mode !== 'running') return;

  // Сначала оцениваем постоянное смещение по кликовой фазе: если
  // человек стабильно говорит на 150–250 мс позже клика, жёсткое
  // округление к ближайшему удару может перескочить на следующий
  // и оставить текущий слот пустым. Смещение убирает этот скачок.
  const rawBeat = Math.round((t - state.startAt) / BEAT);

  if (rawBeat >= 0 && rawBeat < SOLO_START) {
    const residual = t - (state.startAt + rawBeat * BEAT);
    state.tapResiduals.push(residual);
    if (state.tapResiduals.length > 16) state.tapResiduals.shift();
    if (state.tapResiduals.length >= 3) {
      state.tapOffset = clamp(median(state.tapResiduals), -0.2, 0.2);
    }
  }

  const beat = Math.round((t - state.startAt - state.tapOffset) / BEAT);

  // Поздний/дребезжащий звук за пределами теста не должен
  // сдвигать время предыдущего удара и портить следующий интервал.
  if (beat < 0 || beat >= TOTAL_BEATS) {
    return;
  }

  state.lastTapTime = t;
  state.taps.push({ t, beat });
  ripple();
}

function handleTap(ev) {
  if (state.mode !== 'running') return;

  const stamp = ev && ev.timeStamp ? ev.timeStamp : performance.now();
  const lag = clamp((performance.now() - stamp) / 1000, 0, 0.08);
  tapAt(audioNow() - lag);
}

/* ------------------------------------------------------------ */
/*  Запуск и остановка                                          */
/* ------------------------------------------------------------ */

async function start() {
  if (state.mode === 'running' || starting) return;

  starting = true;
  const token = ++startToken;

  let ctx;
  try {
    ctx = audioInit();
  } catch {
    starting = false;
    setMicStatus('Этот браузер не поддерживает звук (Web Audio API).', true);
    return;
  }
  ctx.resume().catch(() => {});

  showScreen('test');
  setStage({
    kicker: 'Приготовьтесь',
    main: '',
    sub: state.input === 'voice' ? 'Включаем микрофон…' : 'Сейчас начнётся клик',
  });
  setMicStatus('');
  setButtons();

  if (state.input === 'voice') {
    if (!window.MicInput) {
      starting = false;
      showScreen('start');
      setMicStatus('Голосовой ввод не загрузился. Выберите «Тапами».', true);
      setButtons();
      return;
    }

    try {
      await MicInput.enable(ctx);
    } catch (err) {
      if (token !== startToken) return;
      starting = false;
      showScreen('start');
      setMicStatus(micErrorText(err), true);
      setButtons();
      return;
    }

    if (token !== startToken) {
      MicInput.disable();
      return;
    }
  }

  stopTimers();

  state.mode = 'running';
  state.startAt = ctx.currentTime + 0.35;
  state.scheduled = 0;
  state.beats = [];
  state.vis = [];
  state.taps = [];
  state.tapResiduals = [];
  state.tapOffset = 0;
  state.score = null;
  state.endTimer = null;

  state.track.gain.cancelScheduledValues(ctx.currentTime);
  state.track.gain.setValueAtTime(1, ctx.currentTime);

  setStage({ kicker: 'Приготовьтесь', main: '', sub: 'Слушайте: сейчас начнётся клик' });

  if (state.input === 'voice') {
    const micOk = MicInput.start({
      onOnset: tapAt,
      startAt: state.startAt,
      beat: BEAT,
      calibBeats: 3,
    });

    if (!micOk) {
      starting = false;
      abort();
      setMicStatus('Не удалось запустить микрофон. Выберите «Тапами».', true);
      return;
    }
  }

  starting = false;
  setButtons();

  state.schedTimer = setInterval(schedule, 25);
  schedule();
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(frame);
}

function micErrorText(err) {
  if (err && err.code === 'insecure') {
    return 'Микрофон доступен только на 127.0.0.1 или по HTTPS. Выберите «Тапами».';
  }
  if (err && err.code === 'timeout') {
    return 'Браузер не ответил. Разрешите микрофон в адресной строке или выберите «Тапами».';
  }

  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Нет доступа к микрофону. Разрешите его в адресной строке или выберите «Тапами».';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Микрофон не найден. Подключите его или выберите «Тапами».';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Микрофон занят другим приложением.';
    default:
      return 'Не удалось включить микрофон. Выберите «Тапами» или попробуйте ещё раз.';
  }
}

function stopTimers() {
  clearInterval(state.schedTimer);
  clearTimeout(state.endTimer);
  cancelAnimationFrame(state.raf);
  state.schedTimer = null;
  state.endTimer = null;
}

function abort() {
  stopTimers();
  startToken += 1;
  starting = false;
  if (window.MicInput) MicInput.disable();
  state.mode = 'idle';

  if (state.track && state.ctx) {
    state.track.gain.cancelScheduledValues(state.ctx.currentTime);
    state.track.gain.setValueAtTime(1, state.ctx.currentTime);
  }

  showScreen('start');
  if (state.input === 'voice') setMicStatus('Микрофон выключен');
  setButtons();
}

// «Пройти ещё раз» — снова показываем выбор режима, а не запускаем сразу.
function backToStart() {
  stopTimers();
  startToken += 1;
  starting = false;
  if (window.MicInput) MicInput.disable();
  state.mode = 'idle';
  showScreen('start');
  syncModeUI();
  setButtons();
}

function setButtons() {
  const running = state.mode === 'running';
  const busy = starting;

  $('modeTap').disabled = running || busy;
  $('modeVoice').disabled = running || busy;

  const startBtn = $('btnStart');
  startBtn.disabled = running || busy;
  startBtn.textContent = busy && state.input === 'voice'
    ? 'Включаю микрофон…'
    : running ? 'Идёт тест…' : 'Начать тест';

  $('btnStop').disabled = !running;
}

/* ------------------------------------------------------------ */
/*  Финал                                                       */
/* ------------------------------------------------------------ */

function finish() {
  stopTimers();
  if (window.MicInput) MicInput.disable();
  state.mode = 'done';

  renderResults();
  showScreen('results');
  setButtons();
}

function scoreOf(dev) {
  if (dev == null) return 0;
  return Math.round(Math.max(0, 1 - Math.abs(dev) / TOLERANCE_MS) * MAX_PER_BEAT);
}

function buildScoredSlots() {
  // На один удар может прийти несколько «та»: выбираем то, которое
  // ближе всего к ожидаемому клику. Лишние «та» не сдвигают счёт.
  const best = new Map();

  for (const tap of state.taps) {
    if (tap.beat < 0 || tap.beat >= TOTAL_BEATS) continue;
    const expected = state.startAt + tap.beat * BEAT;
    const dist = Math.abs(tap.t - expected);
    const prev = best.get(tap.beat);
    if (!prev || dist < prev.dist) {
      best.set(tap.beat, { beat: tap.beat, t: tap.t, dist });
    }
  }

  const ordered = Array.from(best.values()).sort((a, b) => a.beat - b.beat);
  const slots = new Array(SCORED).fill(null);
  let prev = null;

  for (const item of ordered) {
    if (item.beat >= SOLO_START) {
      const slot = item.beat - SOLO_START;
      const interval = prev == null ? null : (item.t - prev.t) * 1000;
      const dev = interval == null ? null : interval - BEAT_MS;
      slots[slot] = { slot, interval, dev, t: item.t };
    }
    prev = item;
  }

  return slots;
}

function computeResults() {
  const slots = buildScoredSlots();
  const rows = slots.map((slot, i) => {
    const dev = slot ? slot.dev : null;
    return { i, dev, score: scoreOf(dev), missed: !slot, noPrev: !!slot && dev == null };
  });

  const total = rows.reduce((s, r) => s + r.score, 0);
  const devs = rows.filter((r) => r.dev != null).map((r) => r.dev);
  const abs = devs.map(Math.abs);
  const bias = devs.length ? devs.reduce((s, d) => s + d, 0) / devs.length : 0;
  const absAvg = abs.length ? abs.reduce((s, d) => s + d, 0) / abs.length : 0;
  const mean = bias;
  const variance = devs.length
    ? devs.reduce((s, d) => s + (d - mean) ** 2, 0) / devs.length
    : 0;
  const spread = Math.sqrt(variance);
  const best = abs.length ? Math.min(...abs) : null;
  const hit = rows.filter((r) => !r.missed).length;

  return { rows, total, bias, absAvg, spread, best, hit };
}

function rankOf(score) {
  if (score >= 950) return ['Идеальный метроном', 'Почти машинная точность. Темп держится без всякой подсказки.'];
  if (score >= 850) return ['Стальные нервы', 'Очень ровно. Разброс небольшой, темп не плывёт.'];
  if (score >= 700) return ['Твёрдый грув', 'Хорошее чувство темпа, местами спешите или тянете.'];
  if (score >= 550) return ['Чувство есть', 'Основа хорошая, но ровности пока не хватает.'];
  if (score >= 350) return ['Нащупываете', 'Темп уходит. Попробуйте считать вслух и не торопиться.'];
  return ['Пока мимо', 'Тишина сбивает. Пройдите ещё раз и держите шаг ровнее.'];
}

function renderResults() {
  const r = computeResults();
  state.score = r.total;

  $('finalScore').textContent = String(r.total);
  const [title, note] = rankOf(r.total);
  $('finalRank').textContent = title;
  $('finalNote').textContent = note;

  $('statAbs').textContent = `±${fmt(r.absAvg, 1)} мс`;
  $('statSpread').textContent = `±${fmt(r.spread, 1)} мс`;
  $('statBias').textContent = `${r.bias >= 0 ? '+' : ''}${fmt(r.bias, 1)} мс`;
  $('statTaps').textContent = `${r.hit} / ${SCORED}`;

  renderChart(r.rows);
  renderCells(r.rows);

  $('saveMsg').textContent = '';
  $('btnSave').disabled = false;
  // Имя не запоминаем: поле каждый раз пустое.
  $('nameInput').value = '';
}

// Отрисовка вынесена в общий модуль site.js (window.RhythmChart) —
// тот же график показывается и в карточке игрока на странице рекордов.
function renderChart(rows) {
  window.RhythmChart.render($('chart'), rows);
}

function renderCells(rows) {
  $('beatCells').innerHTML = rows
    .map((row) => {
      const cls = row.missed || row.noPrev ? '' : row.score >= 35 ? 'good' : row.score >= 15 ? 'ok' : 'bad';
      return `<i class="${cls}" title="Удар ${row.i + 1}: ${row.score}"></i>`;
    })
    .join('');
}

/* ------------------------------------------------------------ */
/*  Сохранение                                                  */
/* ------------------------------------------------------------ */

async function saveScore(ev) {
  ev.preventDefault();
  if (state.score == null) return;

  const name = $('nameInput').value.trim() || 'Аноним';

  const r = computeResults();
  const btn = $('btnSave');
  btn.disabled = true;
  $('saveMsg').classList.remove('is-error');
  $('saveMsg').textContent = 'Сохраняем…';

  const now = new Date();
  const entry = {
    name,
    score: state.score,
    dev: r.absAvg,
    taps: r.hit,
    mode: state.input,
    // Отклонения по каждому удару — для графика в карточке игрока.
    beats: r.rows.map((row) => (row.dev == null ? null : Math.round(row.dev * 10) / 10)),
    ts: now.getTime() / 1000,
    when: now.toLocaleDateString('ru-RU'),
  };

  try {
    const res = await window.ScoreStore.save(entry);
    if (!res.ok) throw new Error('save failed');
    $('saveMsg').textContent = 'Сохранено! Загляните в «Таблицу рекордов».';
  } catch {
    $('saveMsg').classList.add('is-error');
    $('saveMsg').textContent = 'Не удалось сохранить.';
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ */
/*  Способ ввода                                                */
/* ------------------------------------------------------------ */

function setMicStatus(text, isError) {
  const el = $('micStatus');
  el.textContent = text || '';
  el.classList.toggle('is-error', !!isError);
  el.hidden = !text;
}

function syncModeUI() {
  const voice = state.input === 'voice';

  $('modeTap').classList.toggle('is-on', !voice);
  $('modeTap').setAttribute('aria-pressed', String(!voice));
  $('modeVoice').classList.toggle('is-on', voice);
  $('modeVoice').setAttribute('aria-pressed', String(voice));

  if (voice && state.mode !== 'running' && !starting) {
    setMicStatus('Микрофон включится после «Начать тест». Говорите «та» резко и отчётливо.');
  } else if (!voice) {
    setMicStatus('');
  }
}

function setInput(mode) {
  if (state.mode === 'running' || starting) return;
  state.input = mode === 'voice' ? 'voice' : 'tap';
  try {
    localStorage.setItem('loviritm.input', state.input);
  } catch {}
  syncModeUI();
}

/* ------------------------------------------------------------ */
/*  События                                                     */
/* ------------------------------------------------------------ */

$('modeTap').addEventListener('click', () => setInput('tap'));
$('modeVoice').addEventListener('click', () => setInput('voice'));

$('btnStart').addEventListener('click', () => {
  if (state.mode === 'running') return;
  start();
});

$('btnStop').addEventListener('click', abort);

$('btnAgain').addEventListener('click', backToStart);

$('saveForm').addEventListener('submit', saveScore);

$('stage').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  if (state.mode === 'running' && state.input === 'voice') return;
  handleTap(ev);
});

$('stage').addEventListener('contextmenu', (ev) => ev.preventDefault());

document.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Space' && ev.key !== ' ') return;

  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  ev.preventDefault();
  if (ev.repeat) return;

  if (state.mode === 'running') {
    if (state.input !== 'voice') handleTap(ev);
    return;
  }

  if (state.mode === 'idle' && !$('screenStart').hidden) start();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'running') abort();
});

window.addEventListener('pagehide', () => {
  if (window.MicInput) MicInput.disable();
});

window.addEventListener('pageshow', () => {
  if (state.mode === 'running') abort();
});

window.addEventListener('resize', () => {
  if (state.mode === 'done' && state.score != null) renderChart(computeResults().rows);
});

/* ------------------------------------------------------------ */
/*  Инициализация                                               */
/* ------------------------------------------------------------ */

try {
  if (localStorage.getItem('loviritm.input') === 'voice') state.input = 'voice';
} catch {}

syncModeUI();
setButtons();
showScreen('start');

// Отладочный доступ: удобно проверять логику в консоли.
window.LoviRitm = {
  state,
  start,
  abort,
  handleTap,
  tapAt,
  setInput,
  computeResults,
  renderResults,
  onBeat,
  showScreen,
  backToStart,
};

})();
