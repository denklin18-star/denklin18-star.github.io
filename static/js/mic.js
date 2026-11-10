'use strict';

/* ============================================================
   Лови Ритм — голосовой ввод «та»

   Микрофон только считает уровни в двух полосах:
     — широкая 180–4200 Гц: начало слога;
     — низкая 260–1100 Гц: гласная «а».

   Вся логика детектирования вынесена в VoiceGate. Это позволяет
   не привязываться к абсолютной громкости микрофона и надёжно
   отличать «та» от короткого клика метронома.
   ============================================================ */

(() => {

const FFT = 512;
const POLL_MS = 8;
const HP_HZ = 180;
const LP_BROAD_HZ = 4200;
const HP_LOW_HZ = 260;
const LP_LOW_HZ = 1100;
const CALIB_BEATS = 3;

const st = {
  ctx: null,
  stream: null,
  source: null,
  hp: null,
  hpLow: null,
  lpBroad: null,
  lpLow: null,
  anBroad: null,
  anLow: null,
  sink: null,
  bufBroad: null,
  bufLow: null,
  timer: null,
  sampleRate: 48000,

  onOnset: null,
  active: false,
  gate: null,

  tickBufStart: 0,
  level: 0,
  lowLevel: 0,
};

function rmsOf(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/* Находим самое начало всплеска внутри окна анализатора. */
function findOnset(buf, threshold, sr, bufStart, fallback) {
  if (!buf) return fallback;

  const WIN = 32;
  const STEP = 8;

  for (let i = 0; i + WIN <= buf.length; i += STEP) {
    let sum = 0;
    for (let j = i; j < i + WIN; j++) sum += buf[j] * buf[j];
    if (Math.sqrt(sum / WIN) >= threshold) {
      return bufStart + i / sr;
    }
  }

  return fallback;
}

function insecureError() {
  const e = new Error('insecure');
  e.code = 'insecure';
  return e;
}

function getMicStream(constraints, ms) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const e = new Error('timeout');
      e.code = 'timeout';
      reject(e);
    }, ms);

    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        if (done) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(stream);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function enable(ctx) {
  disable();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw insecureError();
  }

  const stream = await getMicStream(
    {
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    },
    10000
  );

  st.ctx = ctx;
  st.stream = stream;
  st.sampleRate = ctx.sampleRate;
  st.bufBroad = new Float32Array(FFT);
  st.bufLow = new Float32Array(FFT);

  st.source = ctx.createMediaStreamSource(stream);

  st.hp = ctx.createBiquadFilter();
  st.hp.type = 'highpass';
  st.hp.frequency.value = HP_HZ;
  st.hp.Q.value = 0.707;

  st.lpBroad = ctx.createBiquadFilter();
  st.lpBroad.type = 'lowpass';
  st.lpBroad.frequency.value = LP_BROAD_HZ;
  st.lpBroad.Q.value = 0.707;

  st.hpLow = ctx.createBiquadFilter();
  st.hpLow.type = 'highpass';
  st.hpLow.frequency.value = HP_LOW_HZ;
  st.hpLow.Q.value = 0.707;

  st.lpLow = ctx.createBiquadFilter();
  st.lpLow.type = 'lowpass';
  st.lpLow.frequency.value = LP_LOW_HZ;
  st.lpLow.Q.value = 0.707;

  st.anBroad = ctx.createAnalyser();
  st.anBroad.fftSize = FFT;
  st.anBroad.smoothingTimeConstant = 0;

  st.anLow = ctx.createAnalyser();
  st.anLow.fftSize = FFT;
  st.anLow.smoothingTimeConstant = 0;

  // Нулевой выход: граф обрабатывается, но себя не слышно.
  st.sink = ctx.createGain();
  st.sink.gain.value = 0;

  st.source.connect(st.hp);
  st.hp.connect(st.lpBroad);
  st.lpBroad.connect(st.anBroad);

  st.hp.connect(st.hpLow);
  st.hpLow.connect(st.lpLow);
  st.lpLow.connect(st.anLow);

  st.anBroad.connect(st.sink);
  st.anLow.connect(st.sink);
  st.sink.connect(ctx.destination);

  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return true;
}

function start(opts) {
  if (!st.anBroad || !st.anLow || !window.VoiceGate) return false;

  st.onOnset = opts.onOnset || null;

  st.gate = window.VoiceGate.create({
    frameSeconds: FFT / st.sampleRate,
    onOnset: (t) => {
      if (st.onOnset) st.onOnset(t);
    },
    refineOnset: (fallback, threshold) => findOnset(
      st.bufBroad,
      threshold,
      st.sampleRate,
      st.tickBufStart,
      fallback
    ),
  });

  st.gate.start({
    startAt: opts.startAt,
    beat: opts.beat,
    calibBeats: opts.calibBeats || CALIB_BEATS,
  });

  st.active = true;
  clearInterval(st.timer);
  st.timer = setInterval(tick, POLL_MS);
  return true;
}

function tick() {
  if (!st.active || !st.anBroad || !st.gate || !st.ctx) return;

  st.anBroad.getFloatTimeDomainData(st.bufBroad);
  st.anLow.getFloatTimeDomainData(st.bufLow);

  const broad = rmsOf(st.bufBroad);
  const low = rmsOf(st.bufLow);
  const now = st.ctx.currentTime;

  st.level = broad;
  st.lowLevel = low;
  st.tickBufStart = now - FFT / st.sampleRate;

  st.gate.push(broad, low, now);
}

function disable() {
  clearInterval(st.timer);
  st.timer = null;
  st.active = false;
  st.onOnset = null;

  if (st.gate) {
    try {
      st.gate.stop();
    } catch {}
    st.gate = null;
  }

  if (st.stream) {
    try {
      st.stream.getTracks().forEach((t) => t.stop());
    } catch {}
    st.stream = null;
  }

  const nodes = [
    st.source,
    st.hp,
    st.hpLow,
    st.lpBroad,
    st.lpLow,
    st.anBroad,
    st.anLow,
    st.sink,
  ];

  for (const node of nodes) {
    if (node) {
      try {
        node.disconnect();
      } catch {}
    }
  }

  st.source = null;
  st.hp = null;
  st.hpLow = null;
  st.lpBroad = null;
  st.lpLow = null;
  st.anBroad = null;
  st.anLow = null;
  st.sink = null;
  st.bufBroad = null;
  st.bufLow = null;
  st.ctx = null;
  st.level = 0;
  st.lowLevel = 0;
}

window.MicInput = {
  enable,
  start,
  disable,
  get active() {
    return st.active;
  },
  get stats() {
    const g = st.gate ? st.gate.stats() : null;
    return {
      level: st.level,
      low: st.lowLevel,
      noise: g ? g.noise : 0,
      threshold: g ? g.threshold : 0,
      calibrating: false,
      candidate: g ? g.candidate : false,
      onsets: g ? g.onsets : 0,
    };
  },
};

})();
