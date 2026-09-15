/* =============================================================
   Polder Medis — лицо следит за курсором
   Видео используется как источник движения: положение курсора
   переводится в целевое время ролика, а текущее время догоняет
   цель с ограничением скорости и плавным затуханием.
   ============================================================= */
(() => {
  'use strict';

  const CFG = {
    // Файлы: тяжёлый комплект для retina, лёгкий для обычных экранов.
    // Если 2x нет на сервере — берём 1x. Если нет и его — исходник.
    sources: {
      x2: 'assets/video/head-2x.mp4',   // 2560×1440 для retina (из 4K-исходника)
      x1: 'assets/video/head-1x.mp4',
      raw: 'Новое видео лицо.mp4'   // необработанный исходник — крайний случай
    },
    // Порог плотности пикселей, с которого нужен тяжёлый комплект.
    retinaDpr: 1.5,

    // Стартовый стоп-кадр: 'mockup' — поза как в макете (начало ролика, лицо вправо),
    // 'front' — лицо прямо (поза центра экрана).
    startPose: 'mockup',

    // Кадровая частота исходника — сикаем по целым кадрам.
    fps: 4300 / 89, // 215 кадров за 4.45 с (исходник «Новое видео лицо.mp4»)

    // Позы на таймлайне (после зеркала). Ролик: вправо → прямо → влево → прямо → вправо.
    // Каждая половина — самостоятельная шкала «направление → время».
    halves: [
      { right: 0.00, front: 1.15, left: 2.28 },
      { right: 4.45, front: 3.20, left: 2.28 }
    ],

    // Ограничение скорости: секунд видео за секунду реального времени.
    // 1.0 = не быстрее обычного воспроизведения исходника.
    maxSpeed: 1.0,
    // Максимальное ускорение (сек/сек²) — чтобы старт и стоп были мягкими.
    maxAccel: 4.0,
    // Коэффициент догоняния: скорость = diff * gain (пока не упёрлась в maxSpeed).
    gain: 5.0,

    // Мёртвая зона у центра экрана (доля полуширины/полувысоты).
    deadzone: 0.03,
    // Дрожание мыши меньше этого (px) — игнорируем.
    jitterPx: 1.5,

    // Вертикальная ось: в ролике голова не двигается вверх/вниз,
    // поэтому вертикаль передаём лёгким сдвигом головы (в единицах u = 1/1440 ширины).
    vertShiftU: 9,
    vertMaxSpeedU: 40,
    vertGain: 5.0
  };

  const hero = document.getElementById('hero');
  const video = document.getElementById('face');
  const canvas = document.getElementById('faceCanvas');
  const cta = document.getElementById('cta');
  if (!hero || !video || !canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  let mirror = false;        // сырой исходник не отзеркален — зеркалим при отрисовке

  const noHover = window.matchMedia('(hover: none)').matches;

  // ---------- Состояние ----------
  let duration = 0;
  let ready = false;
  let playing = false;       // идёт «продолжение» (обычное воспроизведение)
  let half = 0;              // в какой половине таймлайна находимся

  let tCur = 0;              // текущее время ролика (непрерывное)
  let tTarget = 0;           // целевое время по курсору
  let vel = 0;               // скорость изменения времени (с/с)

  let dyCur = 0, dyTarget = 0, dyVel = 0;   // вертикальный сдвиг (в u)

  let seeking = false;
  let lastSeekFrame = -1;
  let rafId = 0;
  let lastTs = 0;

  let lastPtr = null;        // последняя принятая позиция курсора
  let rect = hero.getBoundingClientRect();
  const uPx = () => rect.width / 1440;

  // ---------- Загрузка в память ----------
  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + ' ' + url);
    const type = res.headers.get('content-type') || '';
    if (type && !/video|octet-stream/.test(type)) throw new Error('not a video: ' + url);
    return await res.blob();
  }

  async function pickSource() {
    const dpr = window.devicePixelRatio || 1;
    const order = dpr >= CFG.retinaDpr
      ? [CFG.sources.x2, CFG.sources.x1, CFG.sources.raw]
      : [CFG.sources.x1, CFG.sources.raw];
    for (const url of order.filter(Boolean)) {
      try {
        const blob = await fetchBlob(url);
        return { url, blob };
      } catch (e) { /* пробуем следующий */ }
    }
    throw new Error('no video source');
  }

  function loadVideo() {
    return pickSource().then(({ url, blob }) => {
      // В сыром исходнике фон серый (~242): поднимаем уровни, чтобы multiply убрал его.
      if (url === CFG.sources.raw) {
        canvas.style.filter = 'brightness(1.09)';
        mirror = true;                               // в исходнике лицо смотрит влево
      }
      return new Promise((resolve, reject) => {
        const onMeta = () => {
          duration = video.duration;
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
          // Последняя поза второй половины = реальный конец ролика.
          CFG.halves[1].right = duration;
          video.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', () => reject(video.error), { once: true });
        video.src = URL.createObjectURL(blob);
        video.load();
      });
    });
  }

  // ---------- Направление → время ----------
  function timeFor(dir, h) {
    const k = CFG.halves[h];
    if (dir >= 0) return k.front + dir * (k.right - k.front);
    return k.front + (-dir) * (k.left - k.front);
  }

  function frameOf(t) { return Math.round(t * CFG.fps); }
  function timeOfFrame(f) { return Math.min(duration - 0.001, Math.max(0, f / CFG.fps + 0.001)); }

  function seekTo(t) {
    const f = frameOf(t);
    if (f === lastSeekFrame) return;
    if (seeking) return;            // дождёмся seeked, потом возьмём свежую цель
    seeking = true;
    lastSeekFrame = f;
    video.currentTime = timeOfFrame(f);
  }

  // ---------- Отрисовка кадра ----------
  function draw() {
    if (video.readyState < 2) return;
    if (mirror) {
      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
  }

  video.addEventListener('seeked', () => {
    draw();
    seeking = false;
    if (!playing && frameOf(tCur) !== lastSeekFrame) seekTo(tCur);
  });

  // ---------- Плавное догоняние ----------
  function approach(cur, target, v, dt, gain, maxSpeed, maxAccel) {
    const diff = target - cur;
    let vWant = diff * gain;
    if (vWant > maxSpeed) vWant = maxSpeed;
    if (vWant < -maxSpeed) vWant = -maxSpeed;
    let dv = vWant - v;
    const dvMax = maxAccel * dt;
    if (dv > dvMax) dv = dvMax;
    if (dv < -dvMax) dv = -dvMax;
    v += dv;
    let next = cur + v * dt;
    // не проскакиваем цель
    if ((diff > 0 && next > target) || (diff < 0 && next < target)) { next = target; v = 0; }
    return [next, v];
  }

  function tick(ts) {
    rafId = 0;
    if (!ready || playing) return;
    const dt = Math.min(0.05, lastTs ? (ts - lastTs) / 1000 : 1 / 60);
    lastTs = ts;

    [tCur, vel] = approach(tCur, tTarget, vel, dt, CFG.gain, CFG.maxSpeed, CFG.maxAccel);
    [dyCur, dyVel] = approach(dyCur, dyTarget, dyVel, dt, CFG.vertGain, CFG.vertMaxSpeedU, CFG.vertMaxSpeedU * 4);

    seekTo(tCur);
    canvas.style.setProperty('--face-dy', (dyCur * uPx()).toFixed(2) + 'px');

    const settled = Math.abs(tTarget - tCur) < 0.0005 && Math.abs(dyTarget - dyCur) < 0.01;
    if (!settled) rafId = requestAnimationFrame(tick);
    else { vel = 0; dyVel = 0; lastTs = 0; }
  }

  function wake() {
    if (!rafId && ready && !playing) rafId = requestAnimationFrame(tick);
  }

  // ---------- Курсор ----------
  function applyDeadzone(v) {
    const a = Math.abs(v);
    if (a <= CFG.deadzone) return 0;
    const s = (a - CFG.deadzone) / (1 - CFG.deadzone);
    return Math.sign(v) * Math.min(1, s);
  }

  function onPointerMove(e) {
    if (noHover || !ready || playing) return;
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;

    if (lastPtr) {
      const d = Math.hypot(e.clientX - lastPtr.x, e.clientY - lastPtr.y);
      if (d < CFG.jitterPx) return;
    }
    lastPtr = { x: e.clientX, y: e.clientY };

    // Положение относительно центра первого экрана, -1…1 по обеим осям.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let nx = (e.clientX - cx) / (rect.width / 2);
    let ny = (e.clientY - cy) / (rect.height / 2);
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));
    nx = applyDeadzone(nx);
    ny = applyDeadzone(ny);

    tTarget = timeFor(nx, half);
    dyTarget = ny * CFG.vertShiftU;    // курсор вверх → голова чуть выше
    wake();
  }

  // ---------- Продолжение (кнопка) ----------
  function playContinuation() {
    if (!ready || playing) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    vel = 0; dyVel = 0; lastTs = 0;

    const atEnd = tCur >= duration - 1 / CFG.fps;
    playing = true;
    const start = atEnd ? 0 : tCur;
    const go = () => {
      video.removeEventListener('seeked', go);
      video.playbackRate = 1;
      video.play().then(drawLoop).catch(() => { playing = false; });
    };
    if (Math.abs(video.currentTime - start) > 0.5 / CFG.fps) {
      video.addEventListener('seeked', go);
      seeking = true;
      video.currentTime = timeOfFrame(frameOf(start));
      lastSeekFrame = frameOf(start);
    } else go();
  }

  // Во время обычного воспроизведения перерисовываем каждый кадр.
  function drawLoop() {
    if (!playing) return;
    draw();
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(drawLoop);
    else requestAnimationFrame(drawLoop);
  }

  function onEnded() {
    playing = false;
    video.pause();
    draw();
    tCur = duration;
    lastSeekFrame = frameOf(duration);
    seeking = false;
    half = 1;                       // дальше живём во второй половине шкалы
    // Цель пересчитается при следующем движении мыши.
    tTarget = tCur;
    if (lastPtr && !noHover) onPointerMove({ clientX: lastPtr.x, clientY: lastPtr.y, pointerType: 'mouse' });
  }

  video.addEventListener('ended', onEnded);
  video.addEventListener('pause', () => { if (playing && video.ended) onEnded(); });
  video.addEventListener('timeupdate', () => {
    if (playing) { tCur = video.currentTime; half = tCur > CFG.halves[0].left ? 1 : 0; }
  });

  if (cta) {
    cta.addEventListener('click', (e) => {
      e.preventDefault();
      playContinuation();
    });
  }

  // ---------- Инициализация ----------
  function onResize() { rect = hero.getBoundingClientRect(); }
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, { passive: true });

  loadVideo().then(() => {
    // Стоп-кадр: начало ролика (поза как в макете).
    const show = () => {
      ready = true;
      draw();
      canvas.classList.add('is-ready');
      canvas.parentElement.classList.add('is-ready');
      video.pause();
      tTarget = tCur;
    };
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); show(); };
    video.addEventListener('seeked', onSeeked);
    tCur = CFG.startPose === 'front' ? CFG.halves[0].front : 0;
    lastSeekFrame = frameOf(tCur);
    video.currentTime = timeOfFrame(lastSeekFrame);
    // На случай если seeked не придёт (некоторые браузеры для t≈0)
    setTimeout(() => { if (!ready) { video.removeEventListener('seeked', onSeeked); show(); } }, 800);

    if (!noHover) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
    }
  }).catch((err) => {
    console.error('Video load failed', err);
  });

  // Отладка из консоли: __faceState()
  window.__faceState = () => ({ tCur, tTarget, vel, dyCur, dyTarget, seeking, lastSeekFrame, half, playing, rafId, vt: video.currentTime });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rafId) { cancelAnimationFrame(rafId); rafId = 0; lastTs = 0; }
    else wake();
  });
})();
