'use strict';

/* ============================================================
   Общие скрипты:
   - локальное хранилище рекордов ( ScoreStore ),
   - статистика и таблица рекордов,
   - карточка игрока,
   - график по ударам,
   - регистрация Service Worker для офлайн-работы.
   ============================================================ */

(() => {

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

const LS_KEY = 'loviritm.scores';
// Для тестирования храним весь рейтинг, а не только первые 20.
// 5000 — практический запас под лимит localStorage.
const MAX_STORED = 5000;
const TOP_N = 20;

/* В Android-приложении Capacitor отдаёт файлы с https://localhost
   (без порта). Там сервера нет — работаем только с localStorage. */
const IS_APP = location.hostname === 'localhost' && !location.port;

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLocal(items) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(items));
  } catch {}
}

function sortItems(items) {
  items.sort((a, b) => {
    const byScore = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (byScore !== 0) return byScore;
    return (Number(a.ts) || 0) - (Number(b.ts) || 0);
  });
  return items;
}

/* ---------------- хранилище рекордов ----------------
   Сначала пытаемся достучаться до сервера (если сайт
   запущен локально через app.py). Если сервера нет —
   берём стартовые результаты из /scores.json и добавляем
   к ним локальные. В Android-приложении сервера нет,
   поэтому рейтинг всегда локальный. */

const STATIC_SCORES = '/scores.json';

async function readStaticScores() {
  if (IS_APP) return [];
  try {
    const res = await fetch(STATIC_SCORES, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data)) return data;
    return Array.isArray(data.scores) ? data.scores : [];
  } catch {
    return [];
  }
}

function mergeScores(staticItems, localItems) {
  const seen = new Set();
  const merged = [];
  for (const item of [...staticItems, ...localItems]) {
    const key = `${item.ts || ''}|${item.name || ''}|${item.score || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return sortItems(merged);
}

const ScoreStore = {
  // limit = 0 — вернуть весь рейтинг.
  async list(limit = 0) {
    const query = limit > 0 ? `?limit=${encodeURIComponent(limit)}` : '';
    if (!IS_APP) {
      try {
        const res = await fetch(`/api/scores${query}`, { headers: { Accept: 'application/json' } });
        if (res.ok) return await res.json();
      } catch {}
    }
    const items = mergeScores(await readStaticScores(), readLocal());
    const scores = limit > 0 ? items.slice(0, limit) : items;
    return { scores, total: items.length };
  },

  async stats() {
    if (!IS_APP) {
      try {
        const res = await fetch('/api/stats', { headers: { Accept: 'application/json' } });
        if (res.ok) return await res.json();
      } catch {}
    }
    const items = mergeScores(await readStaticScores(), readLocal());
    if (!items.length) return { count: 0, best: 0, average: 0 };
    const scores = items.map((it) => Number(it.score) || 0);
    return {
      count: items.length,
      best: Math.round(Math.max(...scores)),
      average: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    };
  },

  async save(entry) {
    if (!IS_APP) {
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (res.ok) return await res.json();
      } catch {}
    }

    const items = sortItems(readLocal());
    items.push(entry);
    sortItems(items);
    const trimmed = items.slice(0, MAX_STORED);
    writeLocal(trimmed);
    return { ok: true, entry, scores: trimmed.slice(0, TOP_N) };
  },
};

window.ScoreStore = ScoreStore;

let items = [];
let average = 0;

const MODE_LABELS = { tap: 'Тапами', voice: 'Голосом' };

function modeTag(mode) {
  const label = MODE_LABELS[mode];
  return label ? `<span class="tag tag--${mode}">${label}</span>` : '—';
}

function rankOf(score) {
  if (score >= 950) return 'Идеальный метроном';
  if (score >= 850) return 'Стальные нервы';
  if (score >= 700) return 'Твёрдый грув';
  if (score >= 550) return 'Чувство есть';
  if (score >= 350) return 'Нащупываете';
  return 'Пока мимо';
}

/* ---------------- статистика ---------------- */

async function loadStats() {
  const nodes = $$('[data-stat]');
  if (!nodes.length) return;

  try {
    const data = await ScoreStore.stats();
    average = Number(data.average) || 0;
    nodes.forEach((el) => {
      el.textContent = String(Math.round(Number(data[el.dataset.stat]) || 0));
    });
  } catch {
    nodes.forEach((el) => { el.textContent = '—'; });
  }
}

/* ---------------- таблица рекордов ---------------- */

async function loadRecordsPage() {
  const body = $('#recordsBody');
  if (!body) return;

  try {
    const data = await ScoreStore.list();
    items = Array.isArray(data.scores) ? data.scores : [];

    if (!items.length) {
      body.innerHTML = `
        <tr><td colspan="7">
          Пока пусто. <a href="/">Пройдите тест</a> и займите первое место.
        </td></tr>`;
      return;
    }

    body.innerHTML = items.map((item, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>
          <button type="button" class="player-link" data-index="${i}"
                  title="Подробный результат">${escapeHtml(item.name)}</button>
        </td>
        <td>${modeTag(item.mode)}</td>
        <td class="num"><b>${Math.round(Number(item.score) || 0)}</b></td>
        <td class="num">${item.dev != null ? `±${Number(item.dev).toFixed(1)} мс` : '—'}</td>
        <td class="num">${item.taps != null ? item.taps : '—'}</td>
        <td class="num">${escapeHtml(item.when || '')}</td>
      </tr>`).join('');
  } catch {
    body.innerHTML = `
      <tr><td colspan="7">Не удалось загрузить таблицу. Проверьте, что сервер запущен.</td></tr>`;
  }
}

/* ---------------- карточка игрока ---------------- */

function dateOf(item) {
  const parts = [];
  if (item.when) parts.push(item.when);
  if (item.ts) {
    const d = new Date(Number(item.ts) * 1000);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    }
  }
  return parts.length ? parts.join(' · ') : 'дата не указана';
}

function openPlayer(index) {
  const item = items[index];
  if (!item) return;

  const score = Math.round(Number(item.score) || 0);
  const diff = Math.round(score - average);
  const modeLabel = MODE_LABELS[item.mode] || '';

  $('#pmName').textContent = item.name || 'Аноним';

  const pmMode = $('#pmMode');
  pmMode.textContent = modeLabel;
  pmMode.className = 'tag' + (modeLabel ? ` tag--${item.mode}` : '');
  pmMode.hidden = !modeLabel;

  $('#pmScore').textContent = String(score);
  $('#pmRank').textContent = rankOf(score);
  $('#pmDev').textContent = item.dev != null ? `±${Number(item.dev).toFixed(1)} мс` : '—';
  $('#pmTaps').textContent = item.taps != null ? `${item.taps} / 20` : '—';
  $('#pmPlace').textContent = `#${index + 1}`;
  $('#pmVs').textContent = average ? `${diff >= 0 ? '+' : ''}${diff}` : '—';
  $('#pmDate').textContent = dateOf(item);

  const beats = Array.isArray(item.beats) ? item.beats : [];
  const hasChart = beats.length > 0;
  $('#pmChart').hidden = !hasChart;
  $('#pmNoChart').hidden = hasChart;
  if (hasChart) {
    window.RhythmChart.render($('#pmChart'), window.RhythmChart.rowsFromBeats(beats));
  } else {
    $('#pmChart').innerHTML = '';
  }

  $('#playerModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePlayer() {
  const modal = $('#playerModal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.player-link');
  if (btn) {
    openPlayer(Number(btn.dataset.index));
    return;
  }
  if (ev.target.closest('[data-close]')) closePlayer();
});

document.addEventListener('keydown', (ev) => {
  const modal = $('#playerModal');
  if (ev.key === 'Escape' && modal && !modal.hidden) closePlayer();
});

/* ---------------- график по ударам (общий) ---------------- */

const MAX_PER_BEAT = 50;
const TOLERANCE_MS = 100;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function scoreOf(dev) {
  if (dev == null) return 0;
  return Math.round(Math.max(0, 1 - Math.abs(dev) / TOLERANCE_MS) * MAX_PER_BEAT);
}

function colorOf(score) {
  if (score >= 35) return '#4ade80';
  if (score >= 15) return '#fbbf24';
  return '#fb7185';
}

function rowsFromBeats(beats) {
  return beats.map((value, i) => {
    const dev = typeof value === 'number' && Number.isFinite(value) ? value : null;
    return { i, dev, score: scoreOf(dev), missed: dev == null, noPrev: false };
  });
}

function renderChartInto(el, rows) {
  const W = 760;
  const H = 340;
  const padL = 58;
  const padR = 22;
  const padT = 42;
  const padB = 42;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const MAXDEV = 100;

  const x = (i) => padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const y = (dev) => padT + ((clampNum(dev, -MAXDEV, MAXDEV) + MAXDEV) / (2 * MAXDEV)) * innerH;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Отклонения по ударам">`];

  for (const d of [-100, -50, 0, 50, 100]) {
    const gy = y(d);
    const zero = d === 0;
    parts.push(
      `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"
        stroke="${zero ? 'rgba(196,181,253,0.55)' : 'rgba(255,255,255,0.07)'}"
        stroke-width="1" ${zero ? 'stroke-dasharray="5 6"' : ''}/>`,
      `<text x="${padL - 12}" y="${gy + 4}" text-anchor="end" font-size="11"
        fill="${zero ? '#c4b5fd' : '#7f8a9d'}">${d > 0 ? '+' + d : d}</text>`
    );
  }

  parts.push(
    `<text x="${padL - 12}" y="${padT - 18}" text-anchor="end" font-size="12" fill="#7f8a9d">раньше</text>`,
    `<text x="${padL - 12}" y="${H - padB + 26}" text-anchor="end" font-size="12" fill="#7f8a9d">позже</text>`
  );

  rows.forEach((row, i) => {
    const n = i + 1;
    if (n === 1 || n % 5 === 0) {
      parts.push(
        `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#7f8a9d">${n}</text>`
      );
    }
  });

  let segment = [];
  const flush = () => {
    if (segment.length > 1) {
      parts.push(
        `<polyline points="${segment.join(' ')}" fill="none" stroke="#8b5cf6" stroke-width="2.5"
          stroke-linejoin="round" stroke-linecap="round"
          style="filter:drop-shadow(0 0 6px rgba(139,92,246,0.55))"/>`
      );
    }
    segment = [];
  };

  rows.forEach((row, i) => {
    if (row.dev == null) {
      flush();
      return;
    }
    segment.push(`${x(i).toFixed(1)},${y(row.dev).toFixed(1)}`);
  });
  flush();

  rows.forEach((row, i) => {
    const n = i + 1;
    const cx = x(i);
    parts.push('<g>');

    if (row.dev == null) {
      const label = row.noPrev ? 'нет предыдущего тапа' : 'пропуск';
      parts.push(
        `<title>Удар ${n}: ${label}</title>`,
        `<circle cx="${cx}" cy="${y(0)}" r="4.5" fill="none" stroke="#3a4356" stroke-width="1.6"/>`
      );
      parts.push('</g>');
      return;
    }

    const color = colorOf(row.score);
    parts.push(
      `<title>Удар ${n}: ${row.dev > 0 ? '+' : ''}${row.dev.toFixed(0)} мс · ${row.score} баллов</title>`,
      `<circle cx="${cx}" cy="${y(row.dev)}" r="5.5" fill="${color}" stroke="#0b0d12" stroke-width="1.5"
        style="filter:drop-shadow(0 0 5px ${color})"/>`
    );
    parts.push('</g>');
  });

  parts.push('</svg>');
  el.innerHTML = parts.join('');
}

window.RhythmChart = {
  render: renderChartInto,
  rowsFromBeats,
  scoreOf,
};

/* ---------------- Service Worker (офлайн) ---------------- */

if ('serviceWorker' in navigator && !IS_APP) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.update())
      .catch(() => {});
  });
}

/* ---------------- старт ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadRecordsPage();
});

})();
