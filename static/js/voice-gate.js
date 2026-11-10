'use strict';

/* ============================================================
   Лови Ритм — детектор голосового слога «та».

   Модуль ничего не знает про микрофон: ему на вход приходят
   уже посчитанные уровни (широкий и низкий), а на выходе —
   время начала гласной. Так его можно проверять без реального
   микрофона и независимо настраивать.

   Логика:
     — адаптивный шумовой порог (не привязан к громкости голоса);
     — начало события ловим по широкой полосе;
     — «та» подтверждаем по низкой полосе, которая должна
       звучать не меньше 45 мс (клик метронома её почти не даёт);
     — ждём 100 мс и проверяем, что звук не затух, как клик;
     — между ударами не меньше 300 мс — это отсекает дребезг.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceGate = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    frameSeconds: 0.011,      // длина окна анализатора
    confirmMs: 100,           // сколько ждём до подтверждения
    maxCandidateMs: 320,      // дольше событие не тянем
    minGapMs: 300,            // минимальный интервал между «та»
    failCooldownMs: 80,       // пауза после неудачного кандидата
    lowRatioStart: 0.11,      // низкая полоса / широкая
    lowAbsMin: 0.0012,
    lowPeakFloor: 0.0016,
    lowVoiceMs: 45,           // низкая полоса должна звучать столько
    lowRecentMs: 35,          // и не оборваться перед подтверждением
    lowResetMs: 25,           // разрыв низкой полосы — это уже другое событие
    noiseMult: 2.2,
    noiseBias: 0.0008,
    absMinRms: 0.0035,
    maxThreshold: 0.12,
    noiseDown: 0.06,
    noiseUp: 0.0015,
    lowNoiseUp: 0.0005,
    minNoise: 0.0008,
    minLowNoise: 0.0005,
    maxNoise: 0.05,
    maxLowNoise: 0.03,
    decayRatio: 0.22,
    decayFloor: 0.0012,
    quietMs: 40,
  });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

  function create(options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const onOnset = typeof cfg.onOnset === 'function' ? cfg.onOnset : () => {};
    const refineOnset = typeof cfg.refineOnset === 'function'
      ? cfg.refineOnset
      : (fallback) => fallback;

    let active = false;
    let startAt = 0;
    let beat = 0.5;
    let detectFrom = 0;

    let noise = 0.003;
    let lowNoise = 0.0015;
    let threshold = cfg.absMinRms;
    let level = 0;
    let lowLevel = 0;

    let inCandidate = false;
    let candStart = 0;
    let candPeak = 0;
    let candLowPeak = 0;
    let candVoiceStart = 0;
    let candLowUntil = 0;
    let candLowRun = 0;
    let candLastLoud = 0;

    let lastOnset = -Infinity;
    let cooldownUntil = 0;
    let onsets = 0;

    function updateNoise(broad, low) {
      // В тишине подстраиваемся быстро, на громких звуках — очень медленно.
      if (broad < threshold * 0.9) {
        noise += (broad - noise) * cfg.noiseDown;
        lowNoise += (low - lowNoise) * cfg.noiseDown;
      } else {
        noise += (broad - noise) * cfg.noiseUp;
        lowNoise += (low - lowNoise) * cfg.lowNoiseUp;
      }
      noise = clamp(noise, cfg.minNoise, cfg.maxNoise);
      lowNoise = clamp(lowNoise, cfg.minLowNoise, cfg.maxLowNoise);
      threshold = clamp(
        noise * cfg.noiseMult + cfg.noiseBias,
        cfg.absMinRms,
        cfg.maxThreshold
      );
    }

    function resetWindow() {
      inCandidate = false;
      candStart = 0;
      candPeak = 0;
      candLowPeak = 0;
      candVoiceStart = 0;
      candLowUntil = 0;
      candLowRun = 0;
      candLastLoud = 0;
    }

    function start(opts) {
      opts = opts || {};
      active = true;
      startAt = num(opts.startAt, 0);
      beat = num(opts.beat, 0.5);
      const calibBeats = Math.max(0, num(opts.calibBeats, 3));
      detectFrom = num(opts.detectFrom, startAt + calibBeats * beat);

      resetWindow();
      lastOnset = -Infinity;
      cooldownUntil = 0;
      onsets = 0;
      level = 0;
      lowLevel = 0;
      noise = 0.003;
      lowNoise = 0.0015;
      threshold = clamp(
        noise * cfg.noiseMult + cfg.noiseBias,
        cfg.absMinRms,
        cfg.maxThreshold
      );
      return true;
    }

    function stop() {
      active = false;
      resetWindow();
    }

    function fail(now) {
      inCandidate = false;
      cooldownUntil = now + cfg.failCooldownMs / 1000;
    }

    function push(broad, low, now) {
      if (!active) return false;

      broad = Math.max(0, num(broad, 0));
      low = Math.max(0, num(low, 0));
      now = num(now, 0);

      level = broad;
      lowLevel = low;

      // До старта и всю фазу «Слушаем» только изучаем фон.
      if (now < startAt || now < detectFrom) {
        updateNoise(broad, low);
        return false;
      }

      if (!inCandidate) {
        updateNoise(broad, low);

        if (now < cooldownUntil) return false;
        if (now - lastOnset < cfg.minGapMs / 1000) return false;
        if (broad < threshold) return false;

        const fallback = Math.max(startAt, now - cfg.frameSeconds);
        let onset = refineOnset(fallback, threshold * 0.65);
        if (!Number.isFinite(onset) || onset < startAt || onset > now) {
          onset = fallback;
        }

        inCandidate = true;
        candStart = onset;
        candPeak = broad;
        candLowPeak = low;
        candVoiceStart = 0;
        candLowUntil = 0;
        candLowRun = 0;
        candLastLoud = now;
        return false;
      }

      candPeak = Math.max(candPeak, broad);
      candLowPeak = Math.max(candLowPeak, low);
      if (broad >= threshold * 0.35) candLastLoud = now;

      const lowFloor = Math.max(
        cfg.lowAbsMin,
        lowNoise * 3.2,
        threshold * 0.22
      );
      const lowStrong = low >= lowFloor &&
        (low >= lowNoise * 4.0 || low >= broad * cfg.lowRatioStart);

      if (lowStrong) {
        candLowRun += 1;
        candLowUntil = now;
        if (!candVoiceStart && candLowRun >= 2) {
          candVoiceStart = Math.max(candStart, now - cfg.frameSeconds);
        }
      } else {
        candLowRun = 0;
        // Короткий низкочастотный «хвост» клика не должен
        // склеиваться с голосом, который прозвучал позже.
        if (candVoiceStart && (now - candLowUntil) > cfg.lowResetMs / 1000) {
          candVoiceStart = 0;
          candLowUntil = 0;
        }
      }

      const elapsed = now - candStart;
      const lowDuration = candVoiceStart ? candLowUntil - candVoiceStart : 0;
      const lowRecent = candVoiceStart > 0 &&
        (now - candLowUntil) <= cfg.lowRecentMs / 1000;
      const lowPeakOk = candLowPeak >= Math.max(
        cfg.lowPeakFloor,
        lowNoise * 2.2,
        threshold * 0.3
      );
      const broadOk = broad >= Math.max(threshold * 0.3, 0.0015);
      const voiced = candVoiceStart > 0 &&
        lowDuration >= cfg.lowVoiceMs / 1000 &&
        lowRecent &&
        lowPeakOk;
      const peakOk = candPeak >= Math.max(threshold * 1.1, noise * 2.4);

      if (elapsed >= cfg.confirmMs / 1000 && voiced && broadOk && peakOk) {
        const onset = candVoiceStart || candStart;
        if (onset - lastOnset >= cfg.minGapMs / 1000) {
          lastOnset = onset;
          onsets += 1;
          onOnset(onset);
        }
        inCandidate = false;
        cooldownUntil = now + cfg.failCooldownMs / 1000;
        return true;
      }

      const decayed = broad < Math.max(threshold * cfg.decayRatio, cfg.decayFloor) &&
        (now - candLastLoud) > cfg.quietMs / 1000;

      if (decayed || elapsed >= cfg.maxCandidateMs / 1000) {
        fail(now);
      }

      return false;
    }

    function stats() {
      return {
        level,
        low: lowLevel,
        noise,
        lowNoise,
        threshold,
        candidate: inCandidate,
        onset: candVoiceStart,
        lastOnset,
        onsets,
      };
    }

    return {
      start,
      stop,
      push,
      stats,
      config: cfg,
      get active() {
        return active;
      },
    };
  }

  return { create, DEFAULTS };
});
