/* Eclipse Studio — сайт */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // Экранирование данных из внешних источников перед вставкой в HTML
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '#');

  /* ================= Движение: общие помощники ================= */
  // Анимации интерфейса идут через Web Animations API: они не спорят с CSS-переходами,
  // снимаются сами по окончании и полностью отключаются при «уменьшении движения»
  const EASE = 'cubic-bezier(.16, 1, .3, 1)';
  const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';
  const canAnimate = !reduced && typeof Element !== 'undefined' && 'animate' in Element.prototype;
  const anim = (el, frames, opts) => (canAnimate && el ? el.animate(frames, { easing: EASE, ...opts }) : null);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Элемент (или его прямоугольник) пересекает окно
  const inView = (r, pad = 0) => r.width > 0 && r.height > 0 && r.bottom > -pad && r.top < window.innerHeight + pad;

  // Короткая подпись меняется «перекатом»; при width:true ширина подстраивается плавно, без скачка соседей
  function swapText(el, text, { width = false } = {}) {
    if (!el) return;
    text = String(text ?? '');
    if (el.textContent === text) return;
    if (!canAnimate || !el.isConnected || !inView(el.getBoundingClientRect(), 40)) { el.textContent = text; return; }
    const w0 = width ? el.getBoundingClientRect().width : 0;
    el.textContent = text;
    const from = { opacity: 0, transform: 'translateY(.55em)' };
    const to = { opacity: 1, transform: 'none' };
    if (width) {
      const w1 = el.getBoundingClientRect().width;
      if (Math.abs(w1 - w0) > .5) { from.width = `${w0}px`; to.width = `${w1}px`; }
    }
    el._swapAnim?.cancel();
    el._swapAnim = anim(el, [from, to], { duration: 420 });
  }

  // Текст абзаца гаснет и проявляется заново; повторные вызовы во время затухания берут последний текст
  function fadeSwap(el, text) {
    if (!el) return;
    text = String(text ?? '');
    el._nextText = text;
    if (el._fadeOut) return;
    if (el.textContent === text) return;
    if (!canAnimate) { el.textContent = text; return; }
    const o = getComputedStyle(el).opacity;
    el._fadeIn?.cancel();
    const out = el.animate([{ opacity: o, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 150, easing: EASE_IN, fill: 'forwards' });
    el._fadeOut = out;
    out.onfinish = () => {
      el.textContent = el._nextText;
      out.cancel();
      el._fadeOut = null;
      el._fadeIn = anim(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 420 });
    };
  }

  // Скользящая подложка под активным пунктом группы кнопок (фильтры, вид, язык).
  // blend — белая подложка в режиме difference: текст под ней инвертируется прямо во время движения
  function makeIndicator(box, itemSel, { blend = false } = {}) {
    if (!box) return () => {};
    const ind = document.createElement('span');
    ind.className = `seg-ind${blend ? ' seg-ind-blend' : ''}`;
    ind.setAttribute('aria-hidden', 'true');
    box.appendChild(ind);
    box.classList.add('has-ind');
    let shown = false;
    const update = () => {
      const act = $$(itemSel, box).find((b) => b.classList.contains('is-active') && !b.hidden);
      if (!act || !box.offsetParent || !act.offsetWidth) { ind.style.opacity = '0'; shown = false; return; }
      const place = () => {
        ind.style.width = `${act.offsetWidth}px`;
        ind.style.height = `${act.offsetHeight}px`;
        ind.style.transform = `translate(${act.offsetLeft}px, ${act.offsetTop}px)`;
      };
      if (shown) { place(); return; }
      // Первая установка — без анимации
      ind.style.transition = 'none';
      place();
      ind.style.opacity = '1';
      void ind.offsetWidth;
      ind.style.transition = '';
      shown = true;
    };
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => update());
      ro.observe(box);
      $$(itemSel, box).forEach((b) => ro.observe(b));
    }
    window.addEventListener('resize', update, { passive: true });
    document.fonts?.ready?.then(update).catch(() => {});
    update();
    return update;
  }

  /* ================= Заставка-мозаика ================= */
  function runLoader() {
    return new Promise((resolve) => {
      const loader = $('#loader');
      if (!loader) return resolve();
      const finish = () => {
        document.body.classList.remove('is-loading');
        loader.classList.add('done');
        resolve();
      };
      if (reduced) { finish(); return; }

      // Повторный визит в рамках сессии — сразу показываем сайт без заставки
      let repeat = false;
      try {
        repeat = sessionStorage.getItem('es-visited') === '1';
        sessionStorage.setItem('es-visited', '1');
      } catch (_) {}
      if (repeat) { finish(); return; }
      // Скрипт сильно запоздал и страховка CSS уже прячет заставку — повторно её не показываем
      if (+getComputedStyle(loader).opacity < 1) { finish(); return; }
      loader.style.animation = 'none'; // заставка запущена — страховочное скрытие не нужно
      const minTime = 1600;

      // Фоновая сетка плиток
      const grid = $('#loaderGrid');
      const size = window.innerWidth < 600 ? 48 : 72;
      const cols = Math.ceil(window.innerWidth / size);
      const rows = Math.ceil(window.innerHeight / size);
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
      const maxD = Math.hypot(cx, cy) || 1;
      const frag = document.createDocumentFragment();
      const tiles = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const t = document.createElement('i');
          const dist = Math.hypot(x - cx, y - cy) / maxD;
          t.style.setProperty('--d', `${Math.round(dist * 520 + Math.random() * 160)}ms`);
          tiles.push(t); frag.appendChild(t);
        }
      }
      grid.appendChild(frag);
      loader.classList.add('tiled');

      // Логотип из фрагментов
      const mark = $('#loaderMark');
      const N = 8, S = 132, cell = S / N;
      mark.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const p = document.createElement('i');
          const ang = Math.random() * Math.PI * 2;
          const r = 60 + Math.random() * 120;
          p.style.backgroundSize = `${S}px ${S}px`;
          p.style.backgroundPosition = `${-x * cell}px ${-y * cell}px`;
          p.style.setProperty('--tx', `${Math.cos(ang) * r}px`);
          p.style.setProperty('--ty', `${Math.sin(ang) * r}px`);
          p.style.setProperty('--rot', `${(Math.random() - .5) * 180}deg`);
          const dist = Math.hypot(x - 3.5, y - 3.5) / 5;
          p.style.setProperty('--d', `${Math.round(dist * 420 + Math.random() * 260)}ms`);
          mark.appendChild(p);
        }
      }

      // Буквы названия
      const title = $('#loaderTitle');
      title.innerHTML = [...title.textContent].map((c, i) =>
        `<span style="--d:${700 + i * 32}ms">${c === ' ' ? '&nbsp;' : c}</span>`).join('');

      requestAnimationFrame(() => requestAnimationFrame(() => loader.classList.add('assemble')));

      // Мерцание плиток
      const flicker = setInterval(() => {
        for (let k = 0; k < 6; k++) {
          const t = tiles[(Math.random() * tiles.length) | 0];
          t.classList.add('flash');
          setTimeout(() => t.classList.remove('flash'), 420);
        }
      }, 140);

      // Прогресс
      const bar = $('#loaderBar'), pct = $('#loaderPct'), step = $('#loaderStep');
      const steps = ['core_engine', 'steam_api', 'smoke_api', 'Eclipse Manifest', 'hypervisor', 'interface'];
      const start = performance.now();
      let loaded = document.readyState === 'complete';
      window.addEventListener('load', () => { loaded = true; }, { once: true });
      // Не держим заставку дольше 2.5 с даже на медленном соединении
      setTimeout(() => { loaded = true; }, 2500);
      let shown = 0;
      let skip = false;
      loader.addEventListener('click', () => { skip = true; });
      // Пропуск заставки любой клавишей
      const onKey = () => { skip = true; };
      window.addEventListener('keydown', onKey, { once: true });

      function tick(now) {
        const t = clamp((now - start) / minTime, 0, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const target = skip ? 1 : (loaded ? eased : Math.min(eased, .9));
        shown += (target - shown) * (skip ? .3 : .12);
        if (target === 1 && shown > .995) shown = 1;
        bar.style.transform = `scaleX(${shown})`;
        pct.textContent = String(Math.round(shown * 100)).padStart(3, '0');
        step.textContent = steps[Math.min(steps.length - 1, Math.floor(shown * steps.length))];
        if (shown < 1) return requestAnimationFrame(tick);
        clearInterval(flicker);
        window.removeEventListener('keydown', onKey);
        setTimeout(() => {
          loader.classList.add('leave');
          document.body.classList.remove('is-loading');
          setTimeout(resolve, 260);
          setTimeout(() => loader.classList.add('done'), 1500);
        }, skip ? 0 : 280);
      }
      requestAnimationFrame(tick);
    });
  }

  /* ================= Разбивка заголовков на слова ================= */
  function splitText() {
    $$('[data-split]').forEach((el) => {
      let i = 0;
      $$('.line', el).forEach((line) => {
        const words = line.textContent.trim().split(/\s+/);
        line.innerHTML = words.map((w) => `<span class="w"><span style="--i:${i++}">${w}</span></span>`).join('');
      });
      el.classList.add('is-split');
    });
  }

  // Общий градиент заголовков: каждое слово получает своё смещение внутри заголовка,
  // поэтому переход от белого к серебристому идёт плавно через все строки
  function paintTitles() {
    $$('[data-split]').forEach((el) => {
      el.style.setProperty('--tw', `${el.clientWidth}px`);
      el.style.setProperty('--th', `${el.clientHeight}px`);
      $$('.w > span', el).forEach((s) => {
        s.style.setProperty('--x', `${s.offsetLeft}px`);
        s.style.setProperty('--y', `${s.offsetTop}px`);
      });
    });
  }
  function initTitleGradient() {
    paintTitles();
    let raf = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paintTitles); }, { passive: true });
    // После загрузки шрифтов ширина слов меняется — пересчитываем
    document.fonts?.ready?.then(paintTitles).catch(() => {});
  }

  /* ================= Появление при прокрутке ================= */
  function initReveal() {
    const items = $$('.reveal, [data-split]');
    if (!('IntersectionObserver' in window) || reduced) { items.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
    items.forEach((e) => io.observe(e));
  }

  /* ================= Счётчики ================= */
  function initCounters() {
    const els = $$('[data-count]');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target;
        const to = +el.dataset.count;
        const from = to === 0 ? 100 : 0;
        const dur = 1600, t0 = performance.now();
        const run = (now) => {
          const k = clamp((now - t0) / dur, 0, 1);
          const v = from + (to - from) * (1 - Math.pow(1 - k, 4));
          el.textContent = Math.round(v);
          if (k < 1) requestAnimationFrame(run);
        };
        if (reduced) el.textContent = to; else requestAnimationFrame(run);
      });
    }, { threshold: .6 });
    els.forEach((e) => io.observe(e));
  }

  /* ================= Шапка и навигация ================= */
  function initHeader() {
    const header = $('#header');
    const nav = $('#nav');
    const burger = $('#burger');
    const progress = $('#progress');
    const fab = $('#toTopFab');
    let lastY = window.scrollY;

    // Мобильное меню: состояние синхронизировано с aria-expanded
    const setMenu = (open) => {
      burger?.classList.toggle('open', open);
      nav.classList.toggle('open', open);
      burger?.setAttribute('aria-expanded', String(open));
      // Пока меню открыто, страница под ним не прокручивается
      document.documentElement.classList.toggle('menu-open', open);
    };
    // При переходе на широкий экран мобильное меню закрываем
    window.matchMedia('(min-width: 961px)').addEventListener?.('change', (e) => { if (e.matches) setMenu(false); });
    burger?.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
    // Порядковый номер пункта — для каскадного появления в мобильном меню
    $$('a', nav).forEach((a, k) => {
      a.style.setProperty('--k', k);
      a.addEventListener('click', () => setMenu(false));
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('open')) { setMenu(false); burger?.focus(); }
    });
    // Закрытие меню по клику вне его
    document.addEventListener('click', (e) => {
      if (!nav.classList.contains('open')) return;
      if (nav.contains(e.target) || burger?.contains(e.target)) return;
      setMenu(false);
    });

    // Кнопка «Наверх»
    fab?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    });

    // Активный пункт меню: раздел, который пересекает линию на 45% высоты окна.
    // Считаем по положению при прокрутке — так подсветка верна и после прыжков по якорям.
    const links = $$('a[href^="#"]', nav);
    const targets = links.map((l) => [l, $(l.getAttribute('href'))]).filter(([, sec]) => sec);
    let current = null;
    const updateActive = () => {
      const line = window.innerHeight * .45;
      let found = null;
      for (const [l, sec] of targets) {
        const r = sec.getBoundingClientRect();
        if (r.top <= line && r.bottom > line) { found = l; break; }
      }
      if (found === current) return;
      current = found;
      links.forEach((l) => {
        l.classList.toggle('active', l === found);
        if (l === found) l.setAttribute('aria-current', 'location'); else l.removeAttribute('aria-current');
      });
    };

    // На телефоне кнопка «Наверх» показывается только при прокрутке вверх,
    // чтобы не перекрывать кнопки скачивания в карточках
    const mqMobile = window.matchMedia('(max-width: 600px)');
    let goingUp = false;
    let fabTimer = 0;
    let ticking = false;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const vh = window.innerHeight;
      header.classList.toggle('scrolled', y > 20);
      document.querySelector('.scroll-hint')?.classList.toggle('gone', y > 40);
      const menuOpen = nav.classList.contains('open');
      header.classList.toggle('hide', !menuOpen && y > 700 && y > lastY + 2);
      if (y < lastY - 2) { header.classList.remove('hide'); goingUp = true; }
      else if (y > lastY + 2) goingUp = false;
      document.documentElement.classList.toggle('hdr-hidden', header.classList.contains('hide'));
      lastY = y;
      // Индикатор прочитанного и появление кнопки «Наверх»
      const max = document.documentElement.scrollHeight - vh;
      if (progress) progress.style.setProperty('--sp', max > 0 ? clamp(y / max, 0, 1).toFixed(4) : '0');
      const showFab = y > vh * 1.2 && (!mqMobile.matches || goingUp);
      fab?.classList.toggle('show', showFab);
      // На телефоне кнопка исчезает сама через пару секунд без прокрутки
      clearTimeout(fabTimer);
      if (showFab && mqMobile.matches) {
        fabTimer = setTimeout(() => { goingUp = false; fab?.classList.remove('show'); }, 2500);
      }
      updateActive();
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  /* ================= Эффекты прокрутки ================= */
  function initScrollFx() {
    const hw = $('#heroWindow');
    const hero = $('.hero');
    const footer = $('.footer');
    // При «уменьшении движения» всё сразу в конечном положении, без привязки к прокрутке
    if (reduced) {
      hw?.style.setProperty('--p', '1');
      footer?.style.setProperty('--fp', '1');
      return;
    }
    let ticking = false;
    let lastHo = '';
    const update = () => {
      ticking = false;
      const vh = window.innerHeight;
      // Первый экран при уходе: текст приподнимается и гаснет, фон отстаёт — появляется глубина
      if (hero) {
        const ho = clamp(window.scrollY / (vh * .85), 0, 1).toFixed(3);
        if (ho !== lastHo) { hero.style.setProperty('--ho', ho); lastHo = ho; }
      }
      if (hw) {
        const r = hw.getBoundingClientRect();
        const p = clamp(1 - (r.top - vh * .25) / (vh * .6), 0, 1);
        hw.style.setProperty('--p', p.toFixed(3));
      }
      if (footer) {
        // Волна букв ECLIPSE: от появления подвала снизу до точки, где его верх на 20% высоты окна.
        // На высоких экранах до этой точки не докрутить — тогда финал ровно в самом низу страницы
        const r = footer.getBoundingClientRect();
        const y = window.scrollY;
        const startY = y + r.top - vh;
        const endY = Math.min(y + r.top - vh * .2, document.documentElement.scrollHeight - vh - 1);
        let fp = endY > startY ? clamp((y - startY) / (endY - startY), 0, 1) : 1;
        if (fp > .995) fp = 1;
        footer.style.setProperty('--fp', fp.toFixed(3));
      }
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ================= Фон / параллакс ================= */
  function initPointerFx() {
    const croc = $('#heroCroc');
    if (!fine || reduced) return;
    window.addEventListener('pointermove', (e) => {
      if (croc && window.scrollY < innerHeight) {
        const dx = (e.clientX / innerWidth - .5), dy = (e.clientY / innerHeight - .5);
        croc.style.setProperty('--px', `${dx * -28}px`);
        croc.style.setProperty('--py', `${dy * -18}px`);
      }
    }, { passive: true });
  }

  // Мягкая подсветка карточек загрузки и благодарности, следующая за курсором
  function initSpotlight() {
    if (!fine || reduced) return;
    $$('.dl-card, .tribute-card').forEach((card) => {
      const spot = document.createElement('span');
      spot.className = 'spot';
      spot.setAttribute('aria-hidden', 'true');
      card.prepend(spot);
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${(e.clientX - r.left).toFixed(0)}px`);
        card.style.setProperty('--my', `${(e.clientY - r.top).toFixed(0)}px`);
      }, { passive: true });
    });
  }

  /* ================= Витрина модулей + лайтбокс ================= */
  function initShowcase() {
    const items = $$('#showcaseList .sc-item');
    const frames = $('#showcaseFrames');
    const label = $('#showcaseLabel');
    const count = $('#showcaseCount');
    const desc = $('#showcaseDesc');
    if (!items.length || !frames) return;
    const total = String(items.length).padStart(2, '0');

    const imgs = items.map((it, i) => {
      const img = new Image();
      // Остальные кадры грузятся лениво и не задерживают первый экран
      if (i > 0) img.loading = 'lazy';
      img.src = it.dataset.img;
      img.alt = it.dataset.title;
      img.decoding = 'async';
      img.width = 1440;
      img.height = 900;
      if (i === 0) img.classList.add('on');
      frames.appendChild(img);
      return img;
    });

    let current = 0;
    // После клика/клавиатуры/закрытия лайтбокса IO ненадолго молчит: иначе сдвиг вёрстки
    // (смена описания, возврат прокрутки) успевает переключить витрину на соседний пункт
    let ioMuteUntil = 0;
    const muteIo = (ms) => { ioMuteUntil = Math.max(ioMuteUntil, performance.now() + ms); };
    // instant — кадр меняется без анимации (витрину синхронизирует закрывающийся лайтбокс)
    function setActive(i, instant = false) {
      if (i === current) return;
      const prev = current;
      current = i;
      items.forEach((it, k) => {
        it.classList.toggle('is-active', k === i);
        it.setAttribute('aria-pressed', String(k === i));
      });
      if (instant) frames.classList.add('is-instant');
      imgs.forEach((im, k) => { im.classList.remove('off'); if (k !== i && k !== prev) im.classList.remove('on'); });
      imgs[prev].classList.remove('on'); imgs[prev].classList.add('off');
      void imgs[i].offsetWidth;
      imgs[i].classList.add('on');
      setTimeout(() => imgs[prev].classList.remove('off'), 900);
      if (instant) {
        void frames.offsetWidth;
        requestAnimationFrame(() => requestAnimationFrame(() => frames.classList.remove('is-instant')));
      }
      swapText(label, items[i].dataset.title);
      swapText(count, `${String(i + 1).padStart(2, '0')} / ${total}`);
      fadeSwap(desc, items[i].dataset.desc);
    }

    // Пункты витрины доступны с клавиатуры: Enter/Пробел и стрелки
    items.forEach((it, i) => {
      it.tabIndex = 0;
      it.setAttribute('role', 'button');
      it.setAttribute('aria-pressed', String(i === 0));
      it.addEventListener('click', () => { muteIo(700); setActive(i); });
      it.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); muteIo(700); setActive(i); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
          muteIo(700);
          items[n].focus();
          setActive(n);
        }
      });
    });

    const io = new IntersectionObserver((entries) => {
      if (performance.now() < ioMuteUntil) return;
      entries.forEach((e) => { if (e.isIntersecting) setActive(items.indexOf(e.target)); });
    }, { rootMargin: window.innerWidth < 960 ? '-62% 0px -30% 0px' : '-48% 0px -48% 0px' });
    items.forEach((it) => io.observe(it));

    /* ---- Лайтбокс: снимок «вылетает» из окна витрины и возвращается в него при закрытии ---- */
    const lb = $('#lightbox'), lbImg = $('#lightboxImg'), lbT = $('#lightboxTitle'), lbD = $('#lightboxDesc'), lbC = $('#lightboxCount');
    const lbFig = $('.lightbox-fig', lb);
    const lbText = lbT?.parentElement;
    const lbClose = $('.lightbox-nav [data-close]', lb);
    const win = $('#showcaseWindow');
    let lbIndex = 0;   // показанный снимок
    let lbTarget = 0;  // снимок, к которому идёт перелистывание
    let lastFocus = null;
    let isOpen = false;
    let swapId = 0;
    let fly = null;

    const fill = (i) => {
      lbIndex = (i + items.length) % items.length;
      const it = items[lbIndex];
      lbImg.src = it.dataset.img; lbImg.alt = it.dataset.title;
      lbT.textContent = it.dataset.title; lbD.textContent = it.dataset.desc;
      if (lbC) lbC.textContent = `${String(lbIndex + 1).padStart(2, '0')} / ${total}`;
    };
    const stopImg = () => {
      lbImg.getAnimations?.().forEach((a) => a.cancel());
      lbText?.getAnimations?.().forEach((a) => a.cancel());
    };
    // «Полёт» снимка между окном витрины и лайтбоксом. События отмены приходят асинхронно,
    // поэтому завершение учитывается только для текущего полёта
    // Преобразование, которое ставит прямоугольник box на место target (масштаб от центра)
    const flipTo = (box, target) => {
      const dx = (target.left + target.width / 2) - (box.left + box.width / 2);
      const dy = (target.top + target.height / 2) - (box.top + box.height / 2);
      return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(target.width / box.width).toFixed(4)})`;
    };
    const startFly = (keyframes, duration) => {
      lb.classList.add('is-flying');
      win.classList.add('is-zoomed');
      const a = lbImg.animate(keyframes, { duration, easing: EASE });
      fly = a;
      const done = () => {
        if (fly !== a) return;
        fly = null;
        lb.classList.remove('is-flying');
        win.classList.remove('is-zoomed');
      };
      a.onfinish = done;
      a.oncancel = done;
    };
    const cancelFly = () => {
      const a = fly;
      fly = null;
      a?.cancel();
      lb.classList.remove('is-flying');
      win.classList.remove('is-zoomed');
    };

    // Перелистывание: снимок уходит в сторону, следующий въезжает с противоположной.
    // fromX — смещение после свайпа, чтобы движение продолжилось с того места, где отпустили палец
    const show = (i, dir = 1, fromX = 0) => {
      if (!isOpen) return;
      const next = (i + items.length) % items.length;
      lbTarget = next;
      const id = ++swapId;
      if (!canAnimate) { fill(next); return; }
      cancelFly();
      const pre = new Image();
      pre.src = items[next].dataset.img;
      const ready = (pre.decode ? pre.decode() : Promise.resolve()).catch(() => {});
      const o0 = lbImg.style.opacity || getComputedStyle(lbImg).opacity;
      stopImg();
      const out = lbImg.animate([
        { opacity: o0, transform: `translateX(${fromX}px)` },
        { opacity: 0, transform: `translateX(${fromX - dir * 72}px) scale(.97)` },
      ], { duration: 220, easing: EASE_IN, fill: 'forwards' });
      lbImg.style.transform = '';
      lbImg.style.opacity = '';
      lbText?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      Promise.all([out.finished.catch(() => {}), Promise.race([ready, wait(700)])]).then(() => {
        if (id !== swapId) return;
        fill(next);
        stopImg();
        anim(lbImg, [{ opacity: 0, transform: `translateX(${dir * 72}px) scale(.97)` }, { opacity: 1, transform: 'none' }], { duration: 560 });
        anim(lbText, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 480 });
      });
    };

    const open = () => {
      if (isOpen) return;
      isOpen = true;
      swapId++;
      lastFocus = document.activeElement;
      stopImg();
      cancelFly();
      fill(current);
      lbTarget = lbIndex;
      const from = frames.getBoundingClientRect();
      lb.classList.add('open');
      lb.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      setTimeout(() => lbClose?.focus({ preventScroll: true }), 60);
      if (!canAnimate || !inView(from)) return;
      const to = lbImg.getBoundingClientRect();
      if (!to.width) return;
      startFly([{ transform: flipTo(to, from) }, { transform: 'none' }], 680);
    };

    const close = () => {
      if (!isOpen) return;
      isOpen = false;
      swapId++;
      // Витрина показывает тот снимок, на котором лайтбокс закрыли, — и он «возвращается» в окно
      muteIo(1000);
      if (lbIndex !== current) setActive(lbIndex, true);
      const cur = lbImg.style.transform || 'none';
      const curO = lbImg.style.opacity || '1';
      stopImg();
      cancelFly();
      lbImg.style.transform = '';
      lbImg.style.opacity = '';
      lb.style.removeProperty('--drag');
      const base = lbImg.getBoundingClientRect();
      const to = frames.getBoundingClientRect();
      lb.classList.remove('open');
      lb.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      lastFocus?.focus?.({ preventScroll: true });
      if (!canAnimate) return;
      if (!inView(to) || !base.width) {
        anim(lbFig, [{ opacity: 1, transform: cur }, { opacity: 0, transform: 'scale(.96)' }], { duration: 300, easing: EASE_IN });
        return;
      }
      startFly([{ transform: cur, opacity: curO }, { transform: flipTo(base, to), opacity: 1 }], 580);
    };

    win.addEventListener('click', open);
    $$('[data-close]', lb).forEach((b) => b.addEventListener('click', close));
    $('#lbPrev').addEventListener('click', () => show(lbTarget - 1, -1));
    $('#lbNext').addEventListener('click', () => show(lbTarget + 1, 1));
    window.addEventListener('keydown', (e) => {
      if (!isOpen) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(lbTarget - 1, -1);
      if (e.key === 'ArrowRight') show(lbTarget + 1, 1);
      // Фокус не покидает открытый лайтбокс
      if (e.key === 'Tab') {
        const f = $$('.lightbox-nav button', lb);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!lb.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    // Свайпы: снимок следует за пальцем; влево/вправо — листать, вниз — закрыть
    let sx = null, sy = null, axis = '', dx = 0, dy = 0;
    lb.addEventListener('touchstart', (e) => {
      if (!isOpen || e.touches.length !== 1) { sx = null; return; }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; axis = ''; dx = 0; dy = 0;
    }, { passive: true });
    lb.addEventListener('touchmove', (e) => {
      if (sx === null || e.touches.length !== 1) return;
      const t = e.touches[0];
      dx = t.clientX - sx; dy = t.clientY - sy;
      if (!axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (canAnimate) { cancelFly(); stopImg(); lb.classList.add('is-dragging'); }
      }
      if (!canAnimate) return;
      if (axis === 'x') {
        lbImg.style.transform = `translateX(${dx}px)`;
        lbImg.style.opacity = String(1 - Math.min(Math.abs(dx) / 700, .45));
      } else {
        // Вверх тянется туго, вниз — свободно: так понятно, что жест закрывает снимок
        const y = dy > 0 ? dy : dy * .25;
        const k = Math.min(Math.abs(y) / 600, 1);
        lbImg.style.transform = `translateY(${y}px) scale(${(1 - k * .15).toFixed(4)})`;
        lb.style.setProperty('--drag', k.toFixed(3));
      }
    }, { passive: true });
    const endDrag = () => {
      if (sx === null) return;
      sx = null;
      lb.classList.remove('is-dragging');
      const a = axis;
      axis = '';
      if (a === 'x' && Math.abs(dx) > 60) { show(lbTarget + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1, canAnimate ? dx : 0); return; }
      if (a === 'y' && dy > 90) { close(); return; }
      // Не дотянули — снимок мягко возвращается на место
      lb.style.removeProperty('--drag');
      if (!canAnimate || !a) return;
      const cur = lbImg.style.transform || 'none';
      const o = lbImg.style.opacity || '1';
      lbImg.style.transform = '';
      lbImg.style.opacity = '';
      anim(lbImg, [{ transform: cur, opacity: o }, { transform: 'none', opacity: 1 }], { duration: 460 });
    };
    lb.addEventListener('touchend', endDrag, { passive: true });
    lb.addEventListener('touchcancel', endDrag, { passive: true });
  }

  /* ================= Сравнение ================= */
  function initCompare() {
    const box = $('#compareBox');
    if (!box) return;
    let drag = false, intro = null, stopped = false, pos = 50, tween = 0, goal = 50;
    // Подписи «Оригинал» / «Eclipse Studio» гаснут, когда разделитель подходит к ним вплотную
    const lblL = $('.compare-label.left', box), lblR = $('.compare-label.right', box);
    let edgeL = 0, edgeR = 100;
    const measureLabels = () => {
      const w = box.clientWidth || 1;
      if (lblL) edgeL = (lblL.offsetLeft + lblL.offsetWidth) / w * 100;
      if (lblR) edgeR = lblR.offsetLeft / w * 100;
    };
    const set = (pct) => {
      pos = clamp(pct, 2, 98);
      box.style.setProperty('--pos', `${pos}%`);
      box.style.setProperty('--lo', clamp((pos - edgeL - 1) / 9, 0, 1).toFixed(2));
      box.style.setProperty('--ro', clamp((edgeR - pos - 1) / 9, 0, 1).toFixed(2));
      box.setAttribute('aria-valuenow', String(Math.round(pos)));
    };
    // Плавный переход ползунка к точке клика или по стрелкам — без рывка
    const glide = (target, dur = 260) => {
      cancelAnimationFrame(tween);
      target = clamp(target, 2, 98);
      goal = target;
      if (reduced || Math.abs(target - pos) < .5) { set(target); return; }
      const from = pos, t0 = performance.now();
      const step = (now) => {
        const k = clamp((now - t0) / dur, 0, 1);
        set(from + (target - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) tween = requestAnimationFrame(step);
      };
      tween = requestAnimationFrame(step);
    };
    const pctOf = (e) => {
      const r = box.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * 100;
    };
    measureLabels();
    window.addEventListener('resize', () => { measureLabels(); set(pos); }, { passive: true });
    document.fonts?.ready?.then(() => { measureLabels(); set(pos); }).catch(() => {});
    box.addEventListener('pointerdown', (e) => {
      drag = true; stopped = true; box.classList.add('drag'); cancelAnimationFrame(intro);
      box.setPointerCapture(e.pointerId); glide(pctOf(e), 220);
    });
    box.addEventListener('pointermove', (e) => { if (drag) { cancelAnimationFrame(tween); set(pctOf(e)); goal = pos; } });
    const stop = () => { drag = false; box.classList.remove('drag'); };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    // Управление ползунком с клавиатуры: стрелки (Shift — крупный шаг), Home/End
    box.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 4;
      const keys = {
        ArrowLeft: goal - step, ArrowDown: goal - step,
        ArrowRight: goal + step, ArrowUp: goal + step,
        Home: 0, End: 100,
      };
      if (!(e.key in keys)) return;
      e.preventDefault();
      stopped = true; cancelAnimationFrame(intro);
      glide(keys[e.key], 200);
    });

    // Демонстрационный проход ползунка
    if (reduced) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      if (stopped) return;
      const keys = [50, 22, 78, 50], dur = 2400, t0 = performance.now() + 500;
      const run = (now) => {
        const k = clamp((now - t0) / dur, 0, 1);
        const seg = Math.min(2, Math.floor(k * 3));
        const local = k * 3 - seg;
        const e = local < .5 ? 4 * local ** 3 : 1 - Math.pow(-2 * local + 2, 3) / 2;
        set(keys[seg] + (keys[seg + 1] - keys[seg]) * e);
        goal = pos;
        if (k < 1 && !drag && !stopped) intro = requestAnimationFrame(run);
      };
      intro = requestAnimationFrame(run);
    }, { threshold: .5 });
    io.observe(box);
  }

  /* ================= Мультиязычность (RU / EN) ================= */
  let currentLang = localStorage.getItem('es-lang') || 'ru';
  if (!['ru', 'en'].includes(currentLang)) currentLang = 'ru';

  const I18N = {
    ru: {
      'nav.modules': 'Модули',
      'nav.compare': 'Сравнение',
      'nav.download': 'Загрузка',
      'nav.games': 'Игры',
      'nav.community': 'Сообщество',
      'games.tag': 'Crack Vault',
      'games.title1': 'Каталог кряков',
      'games.title2': 'для игр Steam.',
      'games.lead': 'База релизов от <span class="tag-chip">DenuvOwO</span> и <span class="tag-chip">ARTIFACT</span>. Прямые ссылки на скачивание архивов и пароли в один клик.',
      'games.searchPlaceholder': 'Найти игру, например Persona',
      'games.count': 'релизов в базе',
      'games.found': 'найдено',
      'games.noPass': 'Без пароля',
      'games.pass': 'Пароль:',
      'games.copyPass': 'Скопировать пароль',
      'games.passCopied': 'Пароль скопирован',
      'games.download': 'Скачать',
      'games.more': 'Показать ещё',
      'games.empty': 'Ничего не нашлось. Проверьте название или сбросьте фильтр.',
      'games.allLoaded': 'Все игры загружены',
      'games.searchAria': 'Поиск по каталогу кряков',
      'games.loadErr': 'Не удалось загрузить каталог игр. Обновите страницу чуть позже.',
      'games.clear': 'Очистить поиск',
      'games.filterAria': 'Фильтр каталога',
      'games.fAll': 'Все',
      'games.fPinned': 'Основные',
      'games.fNoPass': 'Без пароля',
      'games.viewAria': 'Вид каталога',
      'games.viewGrid': 'Плиткой',
      'games.viewList': 'Списком',
      'games.reset': 'Сбросить поиск',
      'games.showAll': 'Показать все',
      'games.shown': 'Показано {n} из {total}',
      'games.layoutHint': 'Показаны результаты для «{q}» — похоже, была включена другая раскладка',
      'games.badgePinned': 'Основное',
      'games.badgeNew': 'Новое',
      'games.tag.ubisoft': 'Только Ubisoft',
      'games.tag.ea': 'Только EA',
      'games.tag.fix': 'Crack fix',
      'games.build': 'Билд',
      'games.passK': 'Пароль',
      'games.passAuto': 'Пароль {p} скопирован — понадобится при распаковке',
      'games.dlTitle': 'Скачать {file}',
      'games.sortTitle': 'Сортировка',
      'games.sort.default': 'По умолчанию',
      'games.sort.new': 'Сначала новые',
      'games.sort.old': 'Сначала старые',
      'games.sort.popular': 'Популярные',
      'games.sort.name': 'По названию',
      'games.sort.cracker': 'По взломщику',
      'games.crackerTitle': 'Взломщик',
      'games.crackerAll': 'Все',
      'games.otherGroup': 'Другие',
      'games.noDate': 'Без даты',
      'games.uploaded': 'Загружено {d}',
      'games.dlsTitle': 'Скачиваний: {n}',
      'games.groupTitle': 'Показать все релизы {g}',
      'games.groupClear': '— снять фильтр',
      'games.groupClearTitle': 'Снять фильтр по взломщику',
      'games.sortNote': 'Дата — когда файл загружен на GitHub, популярность — число скачиваний.',
      'games.sortNoteWait': 'Загружаем даты и скачивания с GitHub…',
      'games.sortNoteOff': 'GitHub сейчас недоступен: новые и старые определяются по номеру билда.',
      'ui.toTop': 'Наверх',
      'ui.prev': 'Предыдущий снимок',
      'ui.next': 'Следующий снимок',
      'ui.close': 'Закрыть',
      'header.download': 'Скачать',
      'hero.tag': 'Eclipse Studio',
      'hero.title1': 'Игровая лаборатория',
      'hero.title2': 'для Steam.',
      'hero.lead': 'Приложение на Rust и Tauri v2: фиксы онлайна, DLC, сохранения, манифесты Eclipse Manifest и гипервизор взломы — в одном окне.',
      'hero.download': 'Скачать',
      'hero.modules': 'Смотреть модули',
      'hero.meta1': 'Windows 10 / 11 · 64-bit',
      'hero.meta2': 'Процессор с AVX2',
      'hero.meta3': 'Portable — без установки',
      'facts.f1.k': '01 / Стек',
      'facts.f1.p': 'Ядро на Rust: мгновенный запуск.',
      'facts.f2.k': '02 / Приватность',
      'facts.f2.p': 'Телеметрии. Приложение работает офлайн и ничего не отправляет.',
      'facts.f3.k': '03 / Оформление',
      'facts.f3.unit': 'тем',
      'facts.f3.p': 'Тёмные и светлые палитры, 12 акцентов и масштаб текста до 140%.',
      'facts.f4.k': '04 / Модули',
      'facts.f4.p': 'Разделов: от фиксов и сохранений до поиска античитов и настройки VBS.',
      'modules.kicker': 'Модули',
      'modules.title1': 'Всё, что нужно игре,',
      'modules.title2': 'в одном окне.',
      'modules.zoomHint': 'Нажмите, чтобы увеличить',
      'compare.kicker': 'Сравнение',
      'compare.title': 'Было. Стало.',
      'compare.lead': 'Потяните разделитель, чтобы сравнить оригинальный Crocodile Gena Studio и Eclipse Studio.',
      'compare.orig': 'Оригинал',
      'compare.new': 'Eclipse Studio',
      'compare.aria': 'Сравнение: оригинал и Eclipse Studio',
      'compare.diffOrig1': '<strong>Ручная распаковка:</strong> скачивание архива в Загрузки, многошаговый мастер и ручной перенос без автоочистки',
      'compare.diffOrig2': '<strong>Внешние зависимости:</strong> батники и бинарники (.bat, .exe) лежали отдельно рядом с программой',
      'compare.diffOrig3': '<strong>Ограниченная кастомизация:</strong> узкий диапазон зума (до 125%), фиксированная ширина меню и синеватый фон',
      'compare.diffOrig4': '<strong>Эмодзи и растровые иконки:</strong> статичные системные пиктограммы Windows, размывающиеся на 4K',
      'compare.diffOrig5': '<strong>Зависание при старте:</strong> пустое белое окно без индикации во время проверки системы',
      'compare.diffOrig6': '<strong>Навязчивые обновления:</strong> сторонние окна браузера, ручное скачивание нового бинарника и мусор из старых версий',
      'compare.diffOrig7': '<strong>Фиксированные пути:</strong> жестко заданная папка сохранения без возможности выбора и быстрого сброса',
      'compare.diffOrig8': '<strong>Фиксированные звуки и меню:</strong> стандартные нестилизуемые селекты без адаптации под тему и отсутствие настройки звуков',
      'compare.diffNew1': '<strong>Автоустановка в 1 клик:</strong> умный разбор структуры архивов, бэкап в .backup_orig и автоудаление',
      'compare.diffNew2': '<strong>Полный Standalone Portable:</strong> 100% единый автономный EXE-файл без внешних скриптов и сторонних папок',
      'compare.diffNew3': '<strong>14 тем + OLED и зум 140%:</strong> глубокие палитры без синевы, 12 неоновых акцентов и гибкий ресайз сайдбара',
      'compare.diffNew4': '<strong>Векторный SVG-сет Lucide:</strong> безупречная чёткость на любых экранах и плавные микроанимации 60 FPS',
      'compare.diffNew5': '<strong>Аппаратная заставка:</strong> Canvas-анимация с логотипом, пошаговый статус загрузки и пропуск по клику',
      'compare.diffNew6': '<strong>Встроенный 1-клик апдейтер:</strong> прямое скачивание в рабочую папку, бесшовный перезапуск, цветной прогресс-бар и сворачиваемый чейнджлог',
      'compare.diffNew7': '<strong>Гибкая настройка путей:</strong> выбор любой папки загрузок со сбросом по умолчанию в 1 клик',
      'compare.diffNew8': '<strong>Кастомные звуки и стильные меню:</strong> конструктор своих звуковых профилей и адаптивные выпадающие меню',
      'dl.kicker': 'Загрузка',
      'dl.title1': 'Один файл.',
      'dl.title2': 'Portable.',
      'dl.eclipseDesc': 'Актуальная ветка: форк с самыми быстрыми обновлениями и улучшениями.',
      'dl.metaRelease': 'Релиз',
      'dl.metaSize': 'Размер',
      'dl.metaAuthor': 'Автор',
      'dl.metaPlatform': 'Платформа',
      'dl.metaRepo': 'Репозиторий',
      'dl.btnDownload': 'Скачать',
      'dl.archive': 'Архив версий',
      'dl.allReleases': 'Все релизы на GitHub',
      'dl.genaDesc': 'Оригинальный проект и релизы от основного автора.',
      'dl.btnDownloadOrig': 'Скачать оригинал',
      'dl.authorRepo': 'Репозиторий автора',
      'dl.itemDownload': 'Скачать ↓',
      'dl.recommended': 'Рекомендуем',
      'dl.startK': 'Быстрый старт',
      'dl.step1T': 'Скачайте EXE',
      'dl.step1P': 'Один портативный файл из последнего релиза на GitHub.',
      'dl.step2T': 'Положите в любую папку',
      'dl.step2P': 'Установка не нужна — можно запускать даже с флешки.',
      'dl.step3T': 'Запустите от администратора',
      'dl.step3P': 'Нужно для VBS, Test Mode и записи в реестр Steam.',
      'sync.ok': 'Данные всех версий синхронизированы с GitHub',
      'sync.err': 'GitHub API недоступен — показаны ссылки на релизы',
      'sync.load': 'Синхронизация с GitHub API…',
      'comm.kicker': 'Сообщество',
      'comm.title1': 'Будьте сообществом',
      'comm.title2': 'Пиратская станция.',
      'comm.r1Title': 'Eclipse Studio',
      'comm.r1Desc': 'Разработчик Eclipse Studio.',
      'comm.r2Title': 'Пиратская Станция',
      'comm.r2Desc': 'Главное сообщество.',
      'comm.r3Title': 'Crocodile HUB',
      'comm.r3Desc': 'Чат помощи, обсуждение оригинала и техподдержка.',
      'comm.copy': 'Копировать',
      'comm.done': 'Готово',
      'comm.copied': 'Ссылка скопирована',
      'tribute.badge': 'Благодарность',
      'tribute.title': 'Спасибо Гене за оригинальную программу',
      'tribute.text': 'Eclipse Studio создан на основе оригинального проекта <strong>Crocodile Gena Studio</strong> от <strong>@LeoBanned / Крокодил Гена</strong>. +Rep за открытый исходный код и за вклад в пиратскую культуру.',
      'tribute.repoBtn': 'GitHub автора',
      'tribute.hubLink': 'Сообщество Crocodile HUB',
      'footer.sub': 'Форк Crocodile Gena Studio · автор оригинала LeoBanned\\Крокодил Гена.',
      'footer.docs': 'Документация',
      'footer.dev': 'Разработчик',
      'footer.toTop': 'Наверх ↑',
      'footer.copy': '© 2026 Eclipse Studio. Распространяется свободно в образовательных и исследовательских целях.'
    },
    en: {
      'nav.modules': 'Modules',
      'nav.compare': 'Comparison',
      'nav.download': 'Download',
      'nav.games': 'Games',
      'nav.community': 'Community',
      'games.tag': 'Crack Vault',
      'games.title1': 'Crack Vault',
      'games.title2': 'for Steam games.',
      'games.lead': 'Release database by <span class="tag-chip">DenuvOwO</span> and <span class="tag-chip">ARTIFACT</span>. Direct archive download links and one-click passwords.',
      'games.searchPlaceholder': 'Find a game, e.g. Persona',
      'games.count': 'releases available',
      'games.found': 'found',
      'games.noPass': 'No password',
      'games.pass': 'Password:',
      'games.copyPass': 'Copy password',
      'games.passCopied': 'Password copied',
      'games.download': 'Download',
      'games.more': 'Show more',
      'games.empty': 'Nothing found. Check the title or reset the filter.',
      'games.allLoaded': 'All games loaded',
      'games.searchAria': 'Search the crack catalog',
      'games.loadErr': 'Could not load the game catalog. Please try again later.',
      'games.clear': 'Clear search',
      'games.filterAria': 'Catalog filter',
      'games.fAll': 'All',
      'games.fPinned': 'Essentials',
      'games.fNoPass': 'No password',
      'games.viewAria': 'Catalog view',
      'games.viewGrid': 'Grid view',
      'games.viewList': 'List view',
      'games.reset': 'Reset search',
      'games.showAll': 'Show all',
      'games.shown': 'Showing {n} of {total}',
      'games.layoutHint': 'Showing results for “{q}” — looks like a different keyboard layout',
      'games.badgePinned': 'Essential',
      'games.badgeNew': 'New',
      'games.tag.ubisoft': 'Ubisoft only',
      'games.tag.ea': 'EA only',
      'games.tag.fix': 'Crack fix',
      'games.build': 'Build',
      'games.passK': 'Password',
      'games.passAuto': 'Password {p} copied — you will need it to extract',
      'games.dlTitle': 'Download {file}',
      'games.sortTitle': 'Sort by',
      'games.sort.default': 'Default order',
      'games.sort.new': 'Newest first',
      'games.sort.old': 'Oldest first',
      'games.sort.popular': 'Most downloaded',
      'games.sort.name': 'Name A–Z',
      'games.sort.cracker': 'By cracker',
      'games.crackerTitle': 'Cracker',
      'games.crackerAll': 'All',
      'games.otherGroup': 'Other',
      'games.noDate': 'No date',
      'games.uploaded': 'Uploaded {d}',
      'games.dlsTitle': '{n} downloads',
      'games.groupTitle': 'Show all {g} releases',
      'games.groupClear': '— clear filter',
      'games.groupClearTitle': 'Clear cracker filter',
      'games.sortNote': 'Date is when the file was uploaded to GitHub; popularity is the download count.',
      'games.sortNoteWait': 'Loading dates and downloads from GitHub…',
      'games.sortNoteOff': 'GitHub is unavailable right now: newest and oldest use the build number.',
      'ui.toTop': 'Back to top',
      'ui.prev': 'Previous screenshot',
      'ui.next': 'Next screenshot',
      'ui.close': 'Close',
      'header.download': 'Download',
      'hero.tag': 'Eclipse Studio',
      'hero.title1': 'Gaming laboratory',
      'hero.title2': 'for Steam.',
      'hero.lead': 'Built with Rust & Tauri v2: online fixes, DLCs, save games, Eclipse Manifest manifests and hypervisor unlocks — all in one window.',
      'hero.download': 'Download',
      'hero.modules': 'Explore modules',
      'hero.meta1': 'Windows 10 / 11 · 64-bit',
      'hero.meta2': 'AVX2-capable CPU',
      'hero.meta3': 'Portable — no install',
      'facts.f1.k': '01 / Stack',
      'facts.f1.p': 'Rust core engine: lightning-fast launch.',
      'facts.f2.k': '02 / Privacy',
      'facts.f2.p': 'Telemetry. Fully offline, no data sent anywhere.',
      'facts.f3.k': '03 / Appearance',
      'facts.f3.unit': 'themes',
      'facts.f3.p': 'Dark & light palettes, 12 accents and text scaling up to 140%.',
      'facts.f4.k': '04 / Modules',
      'facts.f4.p': 'Sections: from online fixes & saves to anticheat audits & VBS.',
      'modules.kicker': 'Modules',
      'modules.title1': 'Everything gaming needs,',
      'modules.title2': 'in one window.',
      'modules.zoomHint': 'Click to enlarge',
      'compare.kicker': 'Comparison',
      'compare.title': 'Before. After.',
      'compare.lead': 'Drag the slider to compare original Crocodile Gena Studio and Eclipse Studio.',
      'compare.orig': 'Original',
      'compare.new': 'Eclipse Studio',
      'compare.aria': 'Comparison: original vs Eclipse Studio',
      'compare.diffOrig1': '<strong>Manual extraction:</strong> downloads to common folder, multi-step staging dialog, and leftover archives',
      'compare.diffOrig2': '<strong>External dependencies:</strong> loose batch scripts and binaries (.bat, .exe) alongside the app',
      'compare.diffOrig3': '<strong>Limited customization:</strong> narrow scale range (up to 125%), fixed sidebar width, and dark-blue tinted canvas',
      'compare.diffOrig4': '<strong>Text emojis & legacy icons:</strong> low-res Windows system icons blurring on HiDPI/4K displays',
      'compare.diffOrig5': '<strong>Freeze on startup:</strong> blank white window without progress indicators while checking the environment',
      'compare.diffOrig6': '<strong>Intrusive manual updates:</strong> external browser tabs, manual binary downloads, and leftover older executables',
      'compare.diffOrig7': '<strong>Fixed file paths:</strong> hardcoded download folder without custom folder selection or quick reset',
      'compare.diffOrig8': '<strong>Fixed audio & browser select:</strong> unstyled browser dropdowns clashing with themes and zero sound effects support',
      'compare.diffNew1': '<strong>1-Click Auto-Install:</strong> smart archive hierarchy parsing, safety backup in .backup_orig, and auto-cleanup',
      'compare.diffNew2': '<strong>True Standalone Portable:</strong> 100% single self-contained executable with embedded loaders and zero external files',
      'compare.diffNew3': '<strong>14 themes + OLED & 140% zoom:</strong> pure black OLED palette, 12 neon accents, and resizable sidebar (180–380px)',
      'compare.diffNew4': '<strong>Vector Lucide SVG icons:</strong> razor-sharp rendering on any screen with hardware 60 FPS micro-animations',
      'compare.diffNew5': '<strong>Hardware Canvas splash:</strong> animated logo intro, subsystem initialization log, and instant click-to-skip',
      'compare.diffNew6': '<strong>In-app 1-Click Auto-Updater:</strong> direct download to app folder, seamless restart, theme-colored progress bar, and collapsible changelog',
      'compare.diffNew7': '<strong>Flexible path management:</strong> select any download directory with 1-click reset to defaults',
      'compare.diffNew8': '<strong>Custom Audio & Native Menus:</strong> custom audio profile designer, one-click preview, and adaptive select menus',
      'dl.kicker': 'Download',
      'dl.title1': 'Single file.',
      'dl.title2': 'Portable.',
      'dl.eclipseDesc': 'Active fork: fast updates and quality-of-life enhancements.',
      'dl.metaRelease': 'Release',
      'dl.metaSize': 'Size',
      'dl.metaAuthor': 'Author',
      'dl.metaPlatform': 'Platform',
      'dl.metaRepo': 'Repository',
      'dl.btnDownload': 'Download',
      'dl.archive': 'Version archive',
      'dl.allReleases': 'All releases on GitHub',
      'dl.genaDesc': 'Original upstream project and releases from the main author.',
      'dl.btnDownloadOrig': 'Download original',
      'dl.authorRepo': "Author's repository",
      'dl.itemDownload': 'Download ↓',
      'dl.recommended': 'Recommended',
      'dl.startK': 'Quick start',
      'dl.step1T': 'Download the EXE',
      'dl.step1P': 'A single portable file from the latest GitHub release.',
      'dl.step2T': 'Put it in any folder',
      'dl.step2P': 'No installation needed — it even runs from a USB drive.',
      'dl.step3T': 'Run as administrator',
      'dl.step3P': 'Required for VBS, Test Mode and Steam registry access.',
      'sync.ok': 'All version data synced with GitHub API',
      'sync.err': 'GitHub API unavailable — showing direct release links',
      'sync.load': 'Syncing with GitHub API…',
      'comm.kicker': 'Community',
      'comm.title1': 'Join the community',
      'comm.title2': 'Pirate Station.',
      'comm.r1Title': 'Eclipse Studio',
      'comm.r1Desc': 'Eclipse Studio developer channel.',
      'comm.r2Title': 'Pirate Station',
      'comm.r2Desc': 'Main community channel.',
      'comm.r3Title': 'Crocodile HUB',
      'comm.r3Desc': 'Help chat, upstream discussions & tech support.',
      'comm.copy': 'Copy',
      'comm.done': 'Done',
      'comm.copied': 'Link copied',
      'tribute.badge': 'Open Source Tribute',
      'tribute.title': 'Thanks to Gena for the original program',
      'tribute.text': 'Eclipse Studio is built upon the foundation of <strong>Crocodile Gena Studio</strong> created by <strong>@LeoBanned / Crocodile Gena</strong>. +Rep for open source and for contributing to pirate culture. ',
      'tribute.repoBtn': "Author's GitHub",
      'tribute.hubLink': 'Crocodile HUB community',
      'footer.sub': 'Fork of Crocodile Gena Studio · original author LeoBanned\\Crocodile Gena.',
      'footer.docs': 'Documentation',
      'footer.dev': 'Developer',
      'footer.toTop': 'Back to top ↑',
      'footer.copy': '© 2026 Eclipse Studio. Distributed freely for educational and research purposes.'
    }
  };

  const SHOWCASE_I18N = {
    ru: [
      { title: 'Главная', fullTitle: 'Главная страница', p: 'Сводка состояния и быстрый доступ к модулям.', desc: 'Недавние игры, резервные копии, незавершённые операции и предупреждения с переходом в нужный раздел. Блоки и карточки модулей настраиваются.' },
      { title: 'Online Fix', fullTitle: 'Universal Online Fix', p: 'Сетевой кооператив и лобби Spacewar.', desc: 'Анализ исполняемых файлов, эмуляторы Steam, лобби Spacewar и фиксы Epic Online Services.' },
      { title: 'Сохранения', fullTitle: 'Менеджер сохранений', p: 'Поиск, бэкап и восстановление прогресса.', desc: 'Поиск прогресса по 15+ путям Windows, архивация в ZIP/RAR и побайтовое восстановление.' },
      { title: 'DLC Unlocker', fullTitle: 'DLC Unlocker', p: 'Выборочно — через SmokeAPI и CreamAPI.', desc: 'Выборочная разблокировка дополнений Steam через SmokeAPI и CreamAPI.' },
      { title: 'Eclipse Manifest', fullTitle: 'Eclipse Manifest и манифесты', p: 'Манифесты Steam, плагин Millennium и OpenSteamTool v1/v2.', desc: 'Добавление игр в библиотеку Steam через Ryuu и HubCap, плагин Millennium v0.5.2, две версии OpenSteamTool и синхронизация.' },
      { title: 'Гипервизор', fullTitle: 'Гипервизор: Eclipse-HV', p: 'Автономный лаунчер Eclipse-HV v1.1.0 с автопоиском и обходом DSE.', desc: 'Запуск игр без BAT-скриптов с поддержкой AVX-512, Zen 4, Intel 12+ и Secure Boot.' },
      { title: 'Античиты', fullTitle: 'Гипервизор: античиты', p: 'Поиск и удаление античитов.', desc: 'Аудит служб, драйверов и остаточных файлов 12 популярных античитов.' },
      { title: 'VBS & HVCI', fullTitle: 'Гипервизор: VBS и HVCI', p: 'Настройка гипервизора.', desc: 'Управление Virtualization-based Security, изоляцией ядра, DSE и тестовым режимом.' },
      { title: 'Crack Vault', fullTitle: 'Crack Vault', p: 'Каталог с кряками игр от DenuvOwO\\ARTIFACT.', desc: 'Каталог актуальных релизов с паролями и 6-поточным загрузчиком.' },
      { title: 'Утилиты', fullTitle: 'Утилиты', p: 'CirnoDownloader, Sigma, Zapret2.', desc: 'Хаб внешних инструментов: CirnoDownloader, Sigma, Zapret2 и инструкции по настройке.' },
      { title: 'Настройки', fullTitle: 'Настройки', p: 'Темы, акценты, главная, масштаб и язык.', desc: '14 тем, 12 акцентов (в светлой теме — с читаемым контрастом), настройка главной и раздела при запуске, масштаб шрифта и мультиязычность.' },
      { title: 'Telegram Hub', fullTitle: 'Telegram Hub', p: 'Каналы проекта и поддержка.', desc: 'Все официальные сообщества, канал обновлений и поддержка в одном окне.' },
    ],
    en: [
      { title: 'Home', fullTitle: 'Home Screen', p: 'Status summary and quick access to modules.', desc: 'Recent games, backups, pending operations and alerts with a jump to the right section. Blocks and module cards are customizable.' },
      { title: 'Online Fix', fullTitle: 'Universal Online Fix', p: 'Online co-op and Spacewar lobbies.', desc: 'Executable analysis, Steam emulators, Spacewar lobbies, and Epic Online Services fixes.' },
      { title: 'Save Manager', fullTitle: 'Save Game Manager', p: 'Discovery, backup, and restore of progress.', desc: 'Progress discovery across 15+ Windows paths, ZIP/RAR archiving, and byte-accurate recovery.' },
      { title: 'DLC Unlocker', fullTitle: 'DLC Unlocker', p: 'Selective unlock via SmokeAPI & CreamAPI.', desc: 'Selective Steam DLC unlocking powered by SmokeAPI and CreamAPI.' },
      { title: 'Eclipse Manifest', fullTitle: 'Eclipse Manifest & Manifests', p: 'Steam manifests, Millennium plugin and OpenSteamTool v1/v2.', desc: 'Add games to Steam library via Ryuu and HubCap, Millennium v0.5.2 support, dual OpenSteamTool loaders, and cloud sync.' },
      { title: 'Hypervisor', fullTitle: 'Hypervisor: Eclipse-HV', p: 'Standalone Eclipse-HV v1.1.0 launcher with auto-discovery & DSE bypass.', desc: 'Zero-BAT isolated execution with AVX-512, Zen 4, Intel 12+ support & Secure Boot.' },
      { title: 'Anticheats', fullTitle: 'Hypervisor: Anticheats', p: 'Scan and remove anticheat services.', desc: 'Audit services, drivers, and residual files from 12 popular anticheat systems.' },
      { title: 'VBS & HVCI', fullTitle: 'Hypervisor: VBS & HVCI', p: 'Hypervisor & security configuration.', desc: 'Manage Virtualization-based Security, core isolation, DSE, and test mode.' },
      { title: 'Crack Vault', fullTitle: 'Crack Vault', p: 'Game cracks by DenuvOwO\\ARTIFACT.', desc: 'Catalog of current releases with passwords and multi-threaded downloader.' },
      { title: 'Utilities', fullTitle: 'Utilities', p: 'CirnoDownloader, Sigma, Zapret2.', desc: 'External tool hub: CirnoDownloader, Sigma, Zapret2 and setup guides.' },
      { title: 'Settings', fullTitle: 'Settings', p: 'Themes, accents, home, zoom, and language.', desc: '14 themes, 12 accents (readable in the light theme), home page and startup view settings, typography scaling, and multilingual support.' },
      { title: 'Telegram Hub', fullTitle: 'Telegram Hub', p: 'Project channels and community support.', desc: 'All official communities, updates channel, and support in one window.' },
    ]
  };

  function formatReleaseDate(iso, lang = currentLang) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    } catch {
      return iso.slice(0, 10);
    }
  }

  function formatFileSize(bytes, lang = currentLang) {
    if (!bytes) return '';
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return lang === 'en' ? `${mb} MB` : `${mb} МБ`;
  }

  let cachedEclipseReleases = null;
  let cachedGenaReleases = null;
  const syncState = { ok: 0, fail: 0 };

  function setLanguage(lang) {
    if (!I18N[lang]) lang = 'ru';
    currentLang = lang;
    localStorage.setItem('es-lang', lang);
    document.documentElement.lang = lang;

    $$('#langSwitch .lang-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.lang === lang);
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
    });
    updateLangInd();

    const dict = I18N[lang];
    $$('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      const val = dict[key];
      if (!val) return;

      if (el.classList.contains('line')) {
        const parent = el.closest('[data-split]');
        if (parent) {
          // Сохраняем разбиение на слова: на нём держатся анимация появления и градиент заголовка
          const shown = parent.classList.contains('in');
          el.innerHTML = val.split(/\s+/).map((w, k) => `<span class="w"><span style="${shown ? 'transform:none' : `--i:${k}`}">${w}</span></span>`).join('');
        } else {
          el.textContent = val;
        }
      } else if (/<[a-z][\s\S]*>/i.test(val)) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });

    // Обновление витрины модулей
    const scData = SHOWCASE_I18N[lang] || SHOWCASE_I18N.ru;
    const scItems = $$('#showcaseList .sc-item');
    scItems.forEach((it, i) => {
      if (scData[i]) {
        it.dataset.title = scData[i].fullTitle;
        it.dataset.desc = scData[i].desc;
        const h3 = it.querySelector('h3');
        const p = it.querySelector('p');
        if (h3) h3.textContent = scData[i].title;
        if (p) p.textContent = scData[i].p;
      }
    });
    const activeSc = scItems.find((it) => it.classList.contains('is-active')) || scItems[0];
    if (activeSc) {
      const label = $('#showcaseLabel');
      const desc = $('#showcaseDesc');
      if (label) label.textContent = activeSc.dataset.title;
      if (desc) desc.textContent = activeSc.dataset.desc;
    }

    // Обновление релизов
    if (cachedEclipseReleases) {
      renderReleasesUI('eclipse', cachedEclipseReleases);
    }
    if (cachedGenaReleases) {
      renderReleasesUI('gena', cachedGenaReleases);
    }

    // Обновление атрибутов
    $$('[data-i18n-attr]').forEach((el) => {
      (el.dataset.i18nAttr || '').split(';').forEach((pair) => {
        const [attr, key] = pair.split(':').map((v) => v.trim());
        if (attr && key && dict[key]) el.setAttribute(attr, dict[key]);
      });
    });

    // Обновление каталога игр и градиента заголовков
    if (typeof renderGamesList === 'function' && allGames.length) {
      renderGamesList(false);
    }
    paintTitles();

    // Обновление статуса синхронизации
    const sync = $('#syncStatus');
    if (sync && (syncState.ok + syncState.fail >= 2)) {
      sync.lastElementChild.textContent = syncState.fail === 2
        ? dict['sync.err']
        : dict['sync.ok'];
    }
  }

  // Смена языка без «мигания»: видимые тексты гаснут, подменяются и проявляются заново
  let updateLangInd = () => {};
  let langSwapId = 0;
  const LANG_FX_SEL = '[data-i18n], .sc-item h3, .sc-item p, #showcaseLabel, #showcaseDesc, #gamesGrid, #gamesSortLabel, #gamesCountBadge';
  function langTargets() {
    const els = $$(LANG_FX_SEL).filter((el) => (el.id === 'gamesGrid' || !el.closest('#gamesGrid')) && !el.closest('.lightbox, .loader')
      && inView(el.getBoundingClientRect()));
    const set = new Set(els);
    // Вложенные элементы не анимируем дважды — достаточно внешнего
    return els.filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
  }
  function switchLanguage(lang) {
    if (!I18N[lang] || lang === currentLang) return;
    if (!canAnimate) { setLanguage(lang); return; }
    const id = ++langSwapId;
    // Подложка переключателя едет сразу, не дожидаясь смены текстов
    $$('#langSwitch .lang-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.lang === lang));
    updateLangInd();
    const blur = fine ? 'blur(2px)' : 'blur(0px)';
    const targets = langTargets();
    const outs = targets.map((el) => el.animate(
      [{ opacity: getComputedStyle(el).opacity, filter: 'blur(0px)' }, { opacity: 0, filter: blur }],
      { duration: 170, easing: 'ease-in', fill: 'forwards' }
    ));
    Promise.all(outs.map((a) => a.finished.catch(() => {}))).then(() => {
      if (id !== langSwapId) { outs.forEach((a) => a.cancel()); return; }
      setLanguage(lang);
      const after = langTargets();
      outs.forEach((a) => a.cancel());
      after.forEach((el, i) => anim(el, [
        { opacity: 0, transform: 'translateY(5px)', filter: blur },
        { opacity: 1, transform: 'none', filter: 'blur(0px)' },
      ], { duration: 480, delay: Math.min(i, 16) * 14, fill: 'backwards' }));
    });
  }

  function initLanguage() {
    updateLangInd = makeIndicator($('#langSwitch'), '.lang-btn');
    $$('#langSwitch .lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchLanguage(btn.dataset.lang));
    });
    if (currentLang !== 'ru') {
      setLanguage(currentLang);
    }
  }

  /* ================= Релизы GitHub (динамический парсинг всех версий) ================= */
  async function fetchAllReleases(repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new Error('Empty');
    return list.map((rel) => {
      let tag = (rel.tag_name || rel.name || '').trim();
      if (tag && !/^v/i.test(tag)) tag = `v${tag}`;
      let url = rel.html_url;
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      // Приоритетно ищем основной бинарник приложения, исключая сторонние утилиты вроде Eclipse-HV
      const file =
        assets.find((a) => /eclipse-studio.*\.exe$/i.test(a.name)) ||
        assets.find((a) => /crocodile.*\.exe$/i.test(a.name)) ||
        assets.find((a) => !/eclipse-hv|hypervisor/i.test(a.name) && /\.exe$/i.test(a.name)) ||
        assets.find((a) => /\.exe$/i.test(a.name)) ||
        assets.find((a) => /\.zip$/i.test(a.name)) ||
        assets[0];
      if (file?.browser_download_url) {
        url = file.browser_download_url;
      }
      return {
        tag,
        rawDate: rel.published_at || '',
        rawBytes: file?.size || 0,
        url,
        releaseUrl: rel.html_url,
        fileName: file?.name || '',
        prerelease: Boolean(rel.prerelease)
      };
    });
  }

  // Кэш релизов в localStorage: свежий — 30 минут, устаревший используется при сбое API
  const RELEASES_TTL = 30 * 60 * 1000;
  function readReleasesCache(repo) {
    try {
      const c = JSON.parse(localStorage.getItem(`es-rel:${repo}`) || 'null');
      return c && Array.isArray(c.list) && c.list.length ? c : null;
    } catch (_) { return null; }
  }
  function writeReleasesCache(repo, list) {
    try { localStorage.setItem(`es-rel:${repo}`, JSON.stringify({ t: Date.now(), list })); } catch (_) {}
  }
  async function getReleases(repo) {
    const cached = readReleasesCache(repo);
    if (cached && Date.now() - cached.t < RELEASES_TTL) return cached.list;
    try {
      const list = await fetchAllReleases(repo);
      writeReleasesCache(repo, list);
      return list;
    } catch (err) {
      if (cached) return cached.list;
      throw err;
    }
  }

  function renderReleasesUI(prefix, releases) {
    if (!releases || !releases.length) return;
    const latest = releases[0];
    if (latest) {
      if (prefix === 'eclipse') {
        $$('[data-version]').forEach((el) => { el.textContent = latest.tag; });
      } else {
        const genaVer = $('#genaVersion');
        if (genaVer) genaVer.textContent = latest.tag;
      }
      const dateEl = $(`#${prefix}Date`);
      if (dateEl) dateEl.textContent = formatReleaseDate(latest.rawDate, currentLang);
      const sizeEl = $(`#${prefix}Size`);
      if (sizeEl) sizeEl.textContent = formatFileSize(latest.rawBytes, currentLang) || latest.fallbackSize || '—';
      if (latest.url && prefix === 'eclipse') {
        const btn = $(`#${prefix}Btn`);
        if (btn) btn.href = latest.url;
      }
    }
    const countEl = $(`#${prefix}Count`);
    if (countEl) countEl.textContent = String(releases.length);
    renderVersionArchive($(`#${prefix}VersionsList`), releases);
  }

  function renderVersionArchive(container, releases) {
    if (!container) return;
    const dlText = I18N[currentLang]?.['dl.itemDownload'] || 'Скачать ↓';
    container.innerHTML = releases.map((r) => `
      <a href="${esc(safeUrl(r.url))}" class="ver-item" target="_blank" rel="noopener noreferrer" title="${esc(r.tag)}">
        <div class="ver-item-left">
          <span class="ver-item-tag mono">${esc(r.tag)}</span>
          <span class="ver-item-date mono">${formatReleaseDate(r.rawDate, currentLang)}</span>
        </div>
        <div class="ver-item-right">
          ${(formatFileSize(r.rawBytes, currentLang) || r.fallbackSize) ? `<span class="ver-item-size mono">${formatFileSize(r.rawBytes, currentLang) || r.fallbackSize}</span>` : ''}
          <span class="ver-item-dl mono">${dlText}</span>
        </div>
      </a>
    `).join('');
  }

  function bindToggleArchive(btnId, accordionId) {
    const btn = $(`#${btnId}`);
    const accordion = $(`#${accordionId}`);
    if (!btn || !accordion) return;

    let timer = null;

    accordion.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'grid-template-rows' && accordion.classList.contains('is-open')) {
        accordion.classList.add('is-settled');
      }
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      clearTimeout(timer);
      const willOpen = !accordion.classList.contains('is-open');

      if (willOpen) {
        accordion.classList.remove('is-settled');
        accordion.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        timer = setTimeout(() => {
          if (accordion.classList.contains('is-open')) {
            accordion.classList.add('is-settled');
          }
        }, 380);
      } else {
        accordion.classList.remove('is-settled');
        accordion.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function initReleases() {
    const sync = $('#syncStatus');
    const done = () => {
      if (syncState.ok + syncState.fail < 2) return;
      sync.classList.toggle('err', syncState.fail === 2);
      const dict = I18N[currentLang] || I18N.ru;
      sync.lastElementChild.textContent = syncState.fail === 2
        ? dict['sync.err']
        : dict['sync.ok'];
    };

    bindToggleArchive('eclipseToggleVersions', 'eclipseVersionsAccordion');
    bindToggleArchive('genaToggleVersions', 'genaVersionsAccordion');

    // Актуальная версия из разметки (её обновляет bump_version.py)
    const htmlVersion = ($('#eclipseVersion')?.textContent || '').trim();

    // Eclipse Studio
    getReleases('Sparki1337/eclipse-studio')
      .then((releases) => {
        syncState.ok++;
        cachedEclipseReleases = releases;
        renderReleasesUI('eclipse', releases);
      })
      .catch(() => {
        syncState.fail++;
        const fallback = [
          { tag: 'v8.0.0', rawDate: '2026-10-29T18:00:00Z', rawBytes: 48760320, url: 'https://github.com/Sparki1337/eclipse-studio/releases/download/8.0.0/Eclipse-Studio-v8.0.0.exe', fallbackSize: '46.5 МБ' },
          { tag: 'v7.0.3', rawDate: '2026-10-16T11:37:46Z', rawBytes: 47100000, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v7.0.3', fallbackSize: '44.9 МБ' },
          { tag: 'v7.0.2', rawDate: '2026-10-15T20:29:00Z', rawBytes: 46900000, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v7.0.2', fallbackSize: '44.7 МБ' },
          { tag: 'v7.0.1', rawDate: '2026-10-15T15:35:00Z', rawBytes: 46850000, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v7.0.1', fallbackSize: '44.7 МБ' },
          { tag: 'v7.0.0', rawDate: '2026-10-15T12:00:00Z', rawBytes: 46800000, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v7.0.0', fallbackSize: '44.6 МБ' },
          { tag: 'v6.6.7', rawDate: '2026-10-14T18:00:00Z', rawBytes: 46500000, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v6.6.7', fallbackSize: '44.3 МБ' },
          { tag: 'v6.3.0', rawDate: '2026-10-13T18:00:00Z', rawBytes: 44983910, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v6.3.0', fallbackSize: '42.9 МБ' },
          { tag: 'v6.2.0', rawDate: '2026-10-12T12:00:00Z', rawBytes: 44774195, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v6.2.0', fallbackSize: '42.7 МБ' },
          { tag: 'v6.1.0', rawDate: '2026-10-12T10:00:00Z', rawBytes: 44774195, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v6.1.0', fallbackSize: '42.7 МБ' },
          { tag: 'v6.0.0', rawDate: '2026-10-12T08:00:00Z', rawBytes: 44564480, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/v6.0.0', fallbackSize: '42.5 МБ' },
        ];
        // Офлайн-список может отставать: не подменяем текущую версию старой и ведём на releases/latest
        if (/^v\d/.test(htmlVersion) && !fallback.some((r) => r.tag === htmlVersion)) {
          fallback.unshift({ tag: htmlVersion, rawDate: '', rawBytes: 0, url: 'https://github.com/Sparki1337/eclipse-studio/releases/latest' });
        }
        cachedEclipseReleases = fallback;
        renderReleasesUI('eclipse', fallback);
      })
      .finally(done);

    // Crocodile Gena Studio
    getReleases('LeoBanned/crocodile-gena-studio-releases')
      .then((releases) => {
        syncState.ok++;
        cachedGenaReleases = releases;
        renderReleasesUI('gena', releases);
      })
      .catch(() => {
        syncState.fail++;
        const fallback = [
          { tag: 'v5.1.0', rawDate: '2026-10-07T12:00:00Z', rawBytes: 45193625, url: 'https://github.com/LeoBanned/crocodile-gena-studio-releases/releases/tag/v5.1.0', fallbackSize: '43.1 МБ' },
          { tag: 'v5.0.0', rawDate: '2026-08-09T12:00:00Z', rawBytes: 44983910, url: 'https://github.com/LeoBanned/crocodile-gena-studio-releases/releases/tag/v5.0.0', fallbackSize: '42.9 МБ' },
          { tag: 'v4.0.4', rawDate: '2026-08-02T12:00:00Z', rawBytes: 44040192, url: 'https://github.com/LeoBanned/crocodile-gena-studio-releases/releases/tag/v4.0.4', fallbackSize: '42.0 МБ' },
        ];
        cachedGenaReleases = fallback;
        renderReleasesUI('gena', fallback);
      })
      .finally(done);
  }

  /* ================= Копирование ================= */
  function initCopy() {
    $$('.copy-btn').forEach((btn) => {
      let timer = 0;
      btn.addEventListener('click', async () => {
        const ok = await copyText(btn.dataset.copy);
        if (!ok) return;
        const dict = I18N[currentLang] || I18N.ru;
        btn.textContent = dict['comm.done'] || 'Готово';
        btn.classList.remove('ok');
        void btn.offsetWidth; // повторный клик снова проигрывает отклик
        btn.classList.add('ok');
        showToast(dict['comm.copied'] || 'Ссылка скопирована', 1800);
        clearTimeout(timer);
        timer = setTimeout(() => {
          btn.textContent = (I18N[currentLang] || I18N.ru)['comm.copy'] || 'Копировать';
          btn.classList.remove('ok');
        }, 1800);
      });
    });
  }

  /* ================= Каталог кряков (Crack Vault) ================= */
  const PAGE_SIZE = 24;
  let allGames = [];
  let filteredGames = [];
  let displayedCount = PAGE_SIZE;
  // Состояние каталога: фильтр, вид и запрос, исправленный по раскладке
  const GAME_SORT_KEYS = ['default', 'new', 'old', 'popular', 'name', 'cracker'];
  const gamesUi = { filter: 'all', view: 'grid', sort: 'default', group: '', alt: '', query: '', loaded: false };
  try {
    if (localStorage.getItem('es-games-view') === 'list') gamesUi.view = 'list';
    const savedSort = localStorage.getItem('es-games-sort');
    if (GAME_SORT_KEYS.includes(savedSort)) gamesUi.sort = savedSort;
  } catch { /* хранилище недоступно */ }
  // Данные GitHub (даты загрузки и скачивания): wait — ждём, ok — получены, fail — недоступны
  let gamesMeta = 'wait';

  function cleanGameName(name) {
    if (!name) return '';
    return name.replace(/[\uFFFD]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Сжатая форма строки без пробелов и знаков: «FC27» найдёт «FC 27»
  const compactText = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Подстановка значений в строку перевода: fmt('Показано {n}', { n: 5 })
  const fmt = (str, vars) => String(str || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // Русские формы множественного числа: 1 релиз, 2 релиза, 5 релизов
  const pluralRu = (n, forms) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    return b === 1 ? forms[0] : forms[2];
  };
  const totalLabel = (n) => (currentLang === 'en'
    ? `${n} ${n === 1 ? 'release' : 'releases'} available`
    : `${n} ${pluralRu(n, ['релиз', 'релиза', 'релизов'])} в базе`);
  const foundLabel = (n) => (currentLang === 'en' ? `Found: ${n}` : `Найдено: ${n}`);

  // Исправление раскладки: «ыщтшс» → «sonic», «rhzr» → «кряк»
  const KB_RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
  const KB_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
  const swapLayout = (s, from, to) => [...s].map((ch) => { const i = from.indexOf(ch); return i < 0 ? ch : to[i]; }).join('');
  const altLayout = (q) => (/[а-яё]/.test(q) ? swapLayout(q, KB_RU, KB_EN) : /[a-z]/.test(q) ? swapLayout(q, KB_EN, KB_RU) : '');

  // Подсветка совпадения: сначала точная подстрока, затем «гибкая» —
  // символы запроса подряд, но с любыми пробелами и знаками между ними (fc27 → FC 27)
  function highlightMatch(text, q) {
    if (!q) return esc(text);
    let i = text.toLowerCase().indexOf(q);
    let len = q.length;
    if (i < 0) {
      const chars = [...compactText(q)];
      if (chars.length < 2) return esc(text);
      const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]*'), 'iu');
      const m = re.exec(text);
      if (!m) return esc(text);
      i = m.index; len = m[0].length;
    }
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + len))}</mark>${esc(text.slice(i + len))}`;
  }

  // Разбор поля build: номер сборки, метки (Ubisoft, EA, Crack fix) и текстовая инструкция
  function parseBuild(raw, file) {
    const parts = String(raw || '').replace(/\s+/g, ' ').trim().split(/\s*,\s*/).filter(Boolean);
    let build = '';
    let labeled = false;
    const tags = new Set();
    const notes = [];
    const first = parts.shift() || '';
    const m = first.match(/^build\s+(.+)$/i);
    if (m) { build = m[1]; labeled = true; }
    else if (/^(update|v)\s*[\d.]/i.test(first)) build = first;
    else if (first) notes.push(first);
    parts.forEach((p) => {
      if (/^[\d.]+$/.test(p)) build = build ? `${build} · ${p}` : p;
      else if (/ubisoft/i.test(p)) tags.add('ubisoft');
      else if (/\bea\b/i.test(p)) tags.add('ea');
      else if (/crack\s*fix/i.test(p)) tags.add('fix');
      else notes.push(p);
    });
    if (/crack\.?fix/i.test(file)) tags.add('fix');
    // Инструкции в данных часто набраны капсом — приводим к обычному регистру
    const note = notes.map((n) => {
      const letters = n.replace(/[^\p{L}]/gu, '');
      const upper = letters.replace(/[^\p{Lu}]/gu, '');
      return letters.length > 8 && upper.length / letters.length > 0.6 ? n.charAt(0) + n.slice(1).toLowerCase() : n;
    }).join('. ');
    return { build, labeled, tags: [...tags], note };
  }

  // Имя файла и формат архива из ссылки
  function fileInfo(url) {
    let file = '';
    try { file = decodeURIComponent(new URL(url, location.href).pathname.split('/').filter(Boolean).pop() || ''); }
    catch { file = ''; }
    const ext = (file.match(/\.([a-z0-9]{2,4})$/i) || [])[1] || '';
    return { file, ext: ext.toUpperCase() };
  }

  // Взломщик (релиз-группа) из имени файла: «Game.Name-DenuvOwO.rar» → «DenuvOwO»
  function parseGroup(file) {
    const base = String(file || '').replace(/(\.(rar|zip|7z|exe|dll|tar|gz))+$/i, '');
    const parts = base.split('-');
    // Служебные хвосты после группы: «-CrackFix», «-Fix», «-v2»
    const service = /^(crack\.?fix|fix|hotfix|v?\d+(\.\d+)*)$/i;
    while (parts.length > 2 && service.test(parts[parts.length - 1])) parts.pop();
    let group = parts.length > 1 ? parts[parts.length - 1] : '';
    // Имена через подчёркивание: «..._Crack_Only_ARTIFACT»
    if (!group) group = (base.match(/_([A-Z][A-Z0-9]{2,})$/) || [])[1] || '';
    group = group.replace(/\.\d+$/, '').trim(); // «DenuvOwO.2» → «DenuvOwO»
    if (service.test(group)) return '';
    return /^\p{L}[\p{L}\p{N}._]{1,23}$/u.test(group) ? group : '';
  }

  // Отличаются ли строки не больше чем на одну правку (вставка, удаление или замена символа)
  function oneEditApart(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  // Сводим варианты написания к самому частому: регистр и опечатки («DenvOwO» → «DenuvOwO»)
  function normalizeGroups(games) {
    const counts = new Map();
    games.forEach((g) => { if (g.group) counts.set(g.group, (counts.get(g.group) || 0) + 1); });
    const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const canon = new Map();
    names.forEach((n, i) => {
      const low = n.toLowerCase();
      const main = names.slice(0, i).find((m) => {
        const ml = m.toLowerCase();
        return ml === low || (Math.min(ml.length, low.length) >= 5 && oneEditApart(ml, low));
      });
      canon.set(n, main ? canon.get(main) : n);
    });
    games.forEach((g) => { if (g.group) g.group = canon.get(g.group); });
  }

  // Подготовка записей один раз после загрузки: всё нужное для поиска и отрисовки
  function prepareGames(list) {
    const games = list.map((g, idx) => {
      const name = cleanGameName(g.name);
      const { file, ext } = fileInfo(g.url);
      const pass = String(g.password || '').trim();
      return {
        idx, name, url: g.url, pass, file, ext,
        ...parseBuild(g.build, file),
        bnum: Number((String(g.build || '').match(/\d{6,}/) || [])[0]) || 0, // номер билда Steam
        group: parseGroup(file),
        pinned: g.pinned === true,
        isNew: false,
        ts: 0, dls: null, size: 0, // дата загрузки, скачивания и размер — из GitHub
        hay: `${name} ${g.build || ''} ${file}`.toLowerCase(),
        hayc: compactText(`${name} ${file}`),
      };
    });
    normalizeGroups(games);
    return games;
  }

  // Метка «Новое»: три самые свежие загрузки. Без данных GitHub — последние записи списка, как в приложении
  function markNewest() {
    const regular = allGames.filter((g) => !g.pinned);
    const dated = regular.filter((g) => g.ts);
    const newest = new Set(dated.length >= 3 ? [...dated].sort((a, b) => b.ts - a.ts).slice(0, 3) : regular.slice(-3));
    allGames.forEach((g) => { g.isNew = newest.has(g); });
  }

  /* ---- Даты загрузки и скачивания из GitHub Releases ---- */
  const ASSETS_TTL = 30 * 60 * 1000;
  const normUrl = (u) => { const v = String(u || ''); try { return decodeURIComponent(v).toLowerCase(); } catch { return v.toLowerCase(); } };
  const repoOf = (url) => (/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\//i.exec(url || '') || [])[1] || '';

  async function fetchRepoAssets(repo) {
    const map = {};
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error('Bad response');
      list.forEach((rel) => (Array.isArray(rel.assets) ? rel.assets : []).forEach((a) => {
        if (!a.browser_download_url) return;
        map[normUrl(a.browser_download_url)] = [Math.round(Date.parse(a.created_at) / 1000) || 0, a.download_count || 0, a.size || 0];
      }));
      if (list.length < 100) break;
    }
    return map;
  }

  // Кэш как у релизов: свежий — 30 минут, устаревший выручает при сбое или лимите API
  async function getRepoAssets(repo) {
    const key = `es-assets:${repo}`;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch { cached = null; }
    if (cached?.map && Date.now() - cached.t < ASSETS_TTL) return cached.map;
    try {
      const map = await fetchRepoAssets(repo);
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), map })); } catch { /* хранилище переполнено */ }
      return map;
    } catch (err) {
      if (cached?.map) return cached.map;
      throw err;
    }
  }

  // Дополняем записи датами и скачиваниями. Запрашиваем только репозитории, где лежит заметная часть каталога
  async function loadGamesMeta(games) {
    const counts = new Map();
    games.forEach((g) => { const r = repoOf(g.url); if (r) counts.set(r, (counts.get(r) || 0) + 1); });
    const repos = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r);
    if (!repos.length) throw new Error('No GitHub releases in catalog');
    const maps = (await Promise.allSettled(repos.map(getRepoAssets))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!maps.length) throw new Error('GitHub API unavailable');
    const map = Object.assign({}, ...maps);
    let hits = 0;
    games.forEach((g) => {
      const m = map[normUrl(g.url)];
      if (!m) return;
      g.ts = m[0] * 1000; g.dls = m[1]; g.size = m[2];
      hits++;
    });
    if (!hits) throw new Error('No matching assets');
  }

  /* ---- Сортировка ---- */
  const locale = () => (currentLang === 'en' ? 'en-US' : 'ru-RU');
  const capitalize = (v) => v.charAt(0).toUpperCase() + v.slice(1);
  const collators = {};
  const collate = (a, b) => (collators[currentLang] ||= new Intl.Collator(currentLang === 'en' ? 'en' : 'ru', { numeric: true, sensitivity: 'base', ignorePunctuation: true })).compare(a, b);
  // По дате загрузки; если дат нет — по номеру билда. Записи без данных всегда в конце
  const byDate = (dir) => (a, b) => {
    if (a.ts && b.ts) return (a.ts - b.ts) * dir || a.idx - b.idx;
    if (a.ts || b.ts) return a.ts ? -1 : 1;
    if (a.bnum && b.bnum) return (a.bnum - b.bnum) * dir || a.idx - b.idx;
    if (a.bnum || b.bnum) return a.bnum ? -1 : 1;
    return a.idx - b.idx;
  };
  const GAME_SORTS = {
    new: byDate(-1),
    old: byDate(1),
    popular: (a, b) => (b.dls ?? -1) - (a.dls ?? -1) || a.idx - b.idx,
    name: (a, b) => collate(a.name, b.name) || a.idx - b.idx,
    cracker: (a, b) => (!a.group - !b.group) || collate(a.group, b.group) || a.idx - b.idx,
  };

  // Короткая дата: «Сегодня», «Вчера», «3 дня назад», дальше «2 окт» (с годом, если он не текущий)
  function shortDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (days >= 0 && days < 7 && typeof Intl.RelativeTimeFormat === 'function') {
      return capitalize(new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(-days, 'day'));
    }
    const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return d.toLocaleDateString(locale(), opts).replace(/\s+г\.?$/, '').replace(/\./g, '');
  }
  const longDate = (ts) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s+г\.?$/, '');

  // Заголовки групп: месяц загрузки при сортировке по дате, взломщик — при сортировке по взломщику
  function groupKey(g) {
    if (gamesUi.sort === 'cracker') return g.group || '';
    if ((gamesUi.sort === 'new' || gamesUi.sort === 'old') && gamesMeta === 'ok') {
      if (!g.ts) return '';
      const d = new Date(g.ts);
      return `${d.getFullYear()}-${d.getMonth()}`;
    }
    return null;
  }
  function groupLabel(g, dict) {
    if (gamesUi.sort === 'cracker') return g.group || dict['games.otherGroup'];
    if (!g.ts) return dict['games.noDate'];
    return capitalize(new Date(g.ts).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(/\s+г\.?$/, ''));
  }

  const ICON = {
    dl: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
    dlSm: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
  };

  function gameCardHtml(g, q, dict) {
    const t = (k) => dict[k] || I18N.ru[k] || '';
    const badges = [
      g.pinned ? `<span class="game-badge is-pin">${ICON.pin}${t('games.badgePinned')}</span>` : '',
      g.isNew ? `<span class="game-badge is-new">${t('games.badgeNew')}</span>` : '',
      ...g.tags.map((tag) => `<span class="game-tag">${t(`games.tag.${tag}`)}</span>`),
    ].join('');
    const build = g.build
      ? `<span class="game-build">${g.labeled ? `<span class="game-k">${t('games.build')}</span>` : ''}<span class="game-v mono">${esc(g.build)}</span></span>`
      : '';
    const pass = g.pass
      ? `<span class="game-pass"><span class="game-k">${t('games.passK')}</span><button type="button" class="game-pass-pill" data-pass="${esc(g.pass)}" title="${t('games.copyPass')}" aria-label="${t('games.copyPass')}: ${esc(g.pass)}">${ICON.copy}<span class="mono">${esc(g.pass)}</span></button></span>`
      : `<span class="game-no-pass">${t('games.noPass')}</span>`;
    // Верхняя строка: взломщик (клик — фильтр по нему) и дата загрузки; в «Популярных» — число скачиваний
    const dls = g.dls != null ? fmt(t('games.dlsTitle'), { n: g.dls.toLocaleString(locale()) }) : '';
    const when = gamesUi.sort === 'popular' && g.dls != null
      ? `<span class="game-dls" title="${esc(dls)}">${ICON.dlSm}${g.dls.toLocaleString(locale())}</span>`
      : g.ts
        ? `<time class="game-date" datetime="${new Date(g.ts).toISOString().slice(0, 10)}" title="${esc(fmt(t('games.uploaded'), { d: longDate(g.ts) }) + (dls ? ` · ${dls}` : ''))}">${esc(shortDate(g.ts))}</time>`
        : '';
    const who = g.group
      ? `<button type="button" class="game-group" data-group="${esc(g.group)}" title="${esc(fmt(t('games.groupTitle'), { g: g.group }))}">${esc(g.group)}</button>`
      : '';
    const top = who || when ? `<div class="game-top">${who}${when}</div>` : '';
    const dlTitle = fmt(t('games.dlTitle'), { file: g.file || g.name }) + (g.size ? ` · ${formatFileSize(g.size)}` : '');
    return `<article class="game-card${g.pinned ? ' is-pinned' : ''}${top ? '' : ' no-top'}" data-key="${g.idx}">
      ${top}
      <div class="game-main">
        <h3 class="game-name" title="${esc(g.name)}">${highlightMatch(g.name, q)}</h3>
        ${badges ? `<div class="game-badges">${badges}</div>` : ''}
        ${g.note ? `<p class="game-note" title="${esc(g.note)}">${ICON.info}<span>${esc(g.note)}</span></p>` : ''}
      </div>
      <div class="game-meta">${build}${pass}</div>
      <a href="${esc(safeUrl(g.url))}" class="game-dl-btn" target="_blank" rel="noopener noreferrer"${g.pass ? ` data-pass="${esc(g.pass)}"` : ''} title="${esc(dlTitle)}" aria-label="${t('games.download')}: ${esc(g.name)}">${ICON.dl}<span>${t('games.download')}</span>${g.ext ? `<em class="game-ext mono">${esc(g.ext)}</em>` : ''}</a>
    </article>`;
  }

  // Заглушки на время загрузки каталога
  const skeletonHtml = (n) => Array.from({ length: n }, (_, i) => `<div class="game-card is-skeleton" aria-hidden="true" data-key="sk${i}"><span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-btn"></span></div>`).join('');

  /* ---- Анимация перестройки каталога (FLIP) ----
     До перестройки запоминаем, где стояли видимые карточки. После — оставшиеся плавно переезжают
     на новые места, новые проявляются каскадом, а ушедшие гаснут «призраками» на старых местах.
     Карточки ниже экрана проявляются позже, когда до них долистают. */
  const gridFx = { io: null, ghosts: null, height: null };

  function snapGrid(grid) {
    if (!canAnimate || !grid) return null;
    gridFx.ghosts?.replaceChildren();
    const map = new Map();
    grid.querySelectorAll('[data-key]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!inView(r)) return;
      const o = el.classList.contains('is-pending') ? 0 : +getComputedStyle(el).opacity;
      map.set(el.dataset.key, { el, r, o });
    });
    return { map, view: grid.dataset.view, h: grid.offsetHeight };
  }

  function spawnGhosts(list, view) {
    let layer = gridFx.ghosts;
    if (!layer) {
      layer = gridFx.ghosts = document.createElement('div');
      layer.className = 'games-grid games-ghosts';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    layer.dataset.view = view || 'grid';
    list.slice(0, 48).forEach(({ el, r, o }) => {
      if (o < .05) return;
      const c = el.cloneNode(true);
      c.removeAttribute('data-key');
      c.classList.remove('is-pending');
      c.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;`;
      layer.appendChild(c);
      const a = c.animate([{ opacity: o, transform: 'none' }, { opacity: 0, transform: 'scale(.965)' }], { duration: 200, easing: EASE_IN, fill: 'forwards' });
      a.onfinish = () => c.remove();
    });
  }

  // Карточки ниже экрана: прозрачные, пока до них не долистают
  function observePending(list) {
    if (!canAnimate || !list.length || !('IntersectionObserver' in window)) return;
    if (!gridFx.io) {
      gridFx.io = new IntersectionObserver((entries) => {
        let k = 0;
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          gridFx.io.unobserve(e.target);
          e.target.classList.remove('is-pending');
          anim(e.target, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 620, delay: Math.min(k++, 8) * 45, fill: 'backwards' });
        });
      }, { rootMargin: '0px 0px -24px 0px' });
    }
    list.forEach((el) => { el.classList.add('is-pending'); gridFx.io.observe(el); });
  }

  // Новые элементы: видимые — каскадом сразу, остальные — при прокрутке
  function enterNodes(nodes, startDelay = 40) {
    if (!canAnimate) return;
    const later = [];
    let k = 0;
    nodes.forEach((el) => {
      if (!inView(el.getBoundingClientRect())) { later.push(el); return; }
      anim(el, [{ opacity: 0, transform: 'translateY(14px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 540, delay: startDelay + Math.min(k++, 12) * 30, fill: 'backwards' });
    });
    observePending(later);
  }

  // cascade — без переездов: всё видимое проявляется заново (смена вида «плитка/список»)
  function playGrid(grid, snap, { cascade = false, height = true } = {}) {
    if (!snap || !grid) return;
    // Высота сетки меняется плавно, чтобы блоки ниже не прыгали
    gridFx.height?.cancel();
    gridFx.height = null;
    const h1 = grid.offsetHeight;
    if (height && Math.abs(h1 - snap.h) > 2 && inView(grid.getBoundingClientRect(), 200)) {
      grid.classList.add('is-resizing');
      const a = grid.animate([{ height: `${snap.h}px` }, { height: `${h1}px` }], { duration: 560, easing: EASE });
      gridFx.height = a;
      const done = () => { if (gridFx.height === a) { gridFx.height = null; grid.classList.remove('is-resizing'); } };
      a.onfinish = done;
      a.oncancel = done;
    } else grid.classList.remove('is-resizing');

    const kept = new Set();
    const fresh = [];
    grid.querySelectorAll('[data-key]').forEach((el) => {
      const old = snap.map.get(el.dataset.key);
      if (old && !cascade) {
        const r = el.getBoundingClientRect();
        if (!inView(r)) return;
        kept.add(el.dataset.key);
        const dx = old.r.left - r.left, dy = old.r.top - r.top;
        if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && old.o > .99) return;
        anim(el, [{ transform: `translate(${dx}px, ${dy}px)`, opacity: old.o }, { transform: 'none', opacity: 1 }], { duration: 580 });
        return;
      }
      fresh.push(el);
    });
    const gone = [];
    snap.map.forEach((v, key) => { if (!kept.has(key)) gone.push(v); });
    if (gone.length) spawnGhosts(gone, snap.view);
    // Пока «призраки» гаснут, новые карточки ждут, чтобы не накладываться на них
    enterNodes(fresh, gone.length ? 110 : 30);
  }

  // Фильтр, взломщик, поиск и сортировка. «По умолчанию» — порядок исходного списка
  function applyGamesFilter() {
    const q = ($('#gamesSearch')?.value || '').trim().toLowerCase();
    const base = allGames.filter((g) => (gamesUi.filter === 'pinned' ? g.pinned : gamesUi.filter === 'nopass' ? !g.pass : true)
      && (!gamesUi.group || g.group === gamesUi.group));
    const match = (needle) => {
      const nc = compactText(needle);
      return base.filter((g) => g.hay.includes(needle) || (nc.length > 1 && g.hayc.includes(nc)));
    };
    gamesUi.query = q;
    gamesUi.alt = '';
    let res = base;
    if (q) {
      res = match(q);
      if (!res.length) {
        const alt = altLayout(q);
        const altRes = alt && alt !== q ? match(alt) : [];
        if (altRes.length) { res = altRes; gamesUi.alt = alt; }
      }
    }
    // Без данных GitHub «Популярные» остаются в исходном порядке
    const cmp = gamesUi.sort === 'popular' && gamesMeta !== 'ok' ? null : GAME_SORTS[gamesUi.sort];
    filteredGames = cmp ? res.slice().sort(cmp) : res;
  }

  // Подпись кнопки сортировки, отметки в меню и пояснение об источнике дат
  function syncSortUi() {
    const btn = $('#gamesSortBtn');
    if (!btn) return;
    const dict = I18N[currentLang] || I18N.ru;
    const label = dict[`games.sort.${gamesUi.sort}`] || dict['games.sort.default'];
    swapText($('#gamesSortLabel'), label, { width: true });
    btn.setAttribute('aria-label', `${dict['games.sortTitle']}: ${label}`);
    $$('.games-sort-item[data-sort]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.sort === gamesUi.sort));
      if (b.dataset.sort === 'popular') b.setAttribute('aria-disabled', String(gamesMeta !== 'ok'));
    });
    $$('.games-sort-item[data-group]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.group === gamesUi.group)));
    const note = $('#gamesSortNote');
    if (note) note.textContent = dict[gamesMeta === 'ok' ? 'games.sortNote' : gamesMeta === 'fail' ? 'games.sortNoteOff' : 'games.sortNoteWait'];
    setTokenChip($('#gamesGroupChip'), gamesUi.group);
  }

  // Метка выбранного взломщика появляется и исчезает плавно, соседние фильтры отъезжают следом
  function setTokenChip(chip, name) {
    if (!chip) return;
    const show = Boolean(name);
    const nameEl = chip.querySelector('.games-chip-name');
    if (show && nameEl && nameEl.textContent !== name) {
      if (chip.hidden) nameEl.textContent = name; else swapText(nameEl, name);
    }
    if (chip.hidden === !show) return;
    const box = chip.parentElement;
    const animate = canAnimate && box && inView(box.getBoundingClientRect());
    const sibs = animate ? [...box.children].filter((c) => c !== chip && c.classList.contains('games-chip') && !c.hidden) : [];
    const before = sibs.map((c) => c.getBoundingClientRect().left);
    // Уходящая метка гаснет копией на своём месте
    if (animate && !show) {
      const ghost = chip.cloneNode(true);
      ghost.removeAttribute('id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.tabIndex = -1;
      ghost.style.cssText = `position:absolute;left:${chip.offsetLeft}px;top:${chip.offsetTop}px;margin:0;pointer-events:none;z-index:0;`;
      box.appendChild(ghost);
      const a = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.7)' }], { duration: 220, easing: EASE_IN, fill: 'forwards' });
      a.onfinish = () => ghost.remove();
    }
    chip.hidden = !show;
    if (!animate) return;
    sibs.forEach((c, i) => {
      const dx = before[i] - c.getBoundingClientRect().left;
      if (Math.abs(dx) > .5) anim(c, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 520 });
    });
    if (show) anim(chip, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 480 });
  }

  function renderGamesList(append = false) {
    const grid = $('#gamesGrid');
    if (!grid || !gamesUi.loaded) return;
    const dict = I18N[currentLang] || I18N.ru;
    const empty = $('#gamesEmpty');
    const footer = $('#gamesFooter');
    const badge = $('#gamesCountBadge');
    const hint = $('#gamesHint');
    const q = gamesUi.alt || gamesUi.query;
    const narrowed = Boolean(gamesUi.query) || gamesUi.filter !== 'all' || Boolean(gamesUi.group);
    syncSortUi();

    grid.dataset.view = gamesUi.view;
    grid.setAttribute('aria-busy', 'false');
    swapText(badge, narrowed ? foundLabel(filteredGames.length) : totalLabel(allGames.length), { width: true });
    // Полная перерисовка: карточки, ждавшие прокрутки, заменяются новыми
    if (!append) gridFx.io?.disconnect();
    if (hint) {
      hint.hidden = !gamesUi.alt;
      if (gamesUi.alt) hint.textContent = fmt(dict['games.layoutHint'], { q: gamesUi.alt });
    }

    if (!filteredGames.length) {
      grid.innerHTML = '';
      if (empty) empty.hidden = false;
      if (footer) footer.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    const shown = Math.min(displayedCount, filteredGames.length);
    const from = append ? grid.querySelectorAll('.game-card').length : 0;
    // Заголовок перед первой карточкой каждой группы (если групп больше одной)
    let groupCounts = null;
    if (groupKey(filteredGames[0]) !== null) {
      groupCounts = new Map();
      filteredGames.forEach((g) => { const k = groupKey(g); groupCounts.set(k, (groupCounts.get(k) || 0) + 1); });
      if (groupCounts.size < 2) groupCounts = null;
    }
    const html = filteredGames.slice(from, shown).map((g, i) => {
      let head = '';
      if (groupCounts) {
        const k = groupKey(g);
        const pos = from + i;
        if (pos === 0 || groupKey(filteredGames[pos - 1]) !== k) {
          head = `<div class="games-group" role="heading" aria-level="3" data-key="h:${esc(gamesUi.sort)}:${esc(String(k))}"><span>${esc(groupLabel(g, dict))}</span><b class="mono">${groupCounts.get(k)}</b></div>`;
        }
      }
      return head + gameCardHtml(g, q, dict);
    }).join('');
    if (append) grid.insertAdjacentHTML('beforeend', html);
    else grid.innerHTML = html;

    const remaining = filteredGames.length - shown;
    if (footer) {
      footer.hidden = remaining <= 0;
      const moreCount = $('#gamesMoreCount');
      const shownEl = $('#gamesShown');
      const bar = $('#gamesProgress');
      if (moreCount) moreCount.textContent = `+${Math.min(remaining, PAGE_SIZE)}`;
      if (shownEl) shownEl.textContent = fmt(dict['games.shown'], { n: shown, total: filteredGames.length });
      if (bar) bar.style.width = `${(shown / filteredGames.length * 100).toFixed(1)}%`;
      const allBtn = $('#gamesShowAll');
      if (allBtn) allBtn.hidden = remaining <= PAGE_SIZE;
    }
  }

  // Копирование в буфер с запасным способом для старых браузеров
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  let toastTimer = 0;
  function showToast(msg, ms = 2400) {
    const toast = $('#toast');
    if (!toast) return;
    // Новое сообщение поверх показанного — короткий «толчок», чтобы смена была заметна
    if (toast.classList.contains('show') && toast.textContent !== msg) {
      anim(toast, [{ transform: 'translate(-50%, 0) scale(.95)' }, { transform: 'translate(-50%, 0)' }], { duration: 380 });
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function initGames() {
    const searchInput = $('#gamesSearch');
    const clearBtn = $('#gamesSearchClear');
    const grid = $('#gamesGrid');
    const toolbar = $('#gamesToolbar');
    const dictNow = () => I18N[currentLang] || I18N.ru;
    if (!grid) return;

    grid.innerHTML = skeletonHtml(8);
    // Скользящие подложки под активным фильтром и видом
    const updateChipsInd = makeIndicator($('.games-filters'), '.games-chip[data-filter]', { blend: true });
    const updateViewInd = makeIndicator($('.games-view'), '.games-view-btn');

    // Если пользователь был глубоко в списке, после смены фильтра возвращаем к началу результатов:
    // панель оказывается на своём месте сразу под шапкой, первые карточки — под ней
    const keepResultsInView = () => {
      if (!toolbar) return;
      const headerH = $('#header')?.offsetHeight || 68;
      const target = window.scrollY + grid.getBoundingClientRect().top - toolbar.offsetHeight - headerH - 36;
      if (window.scrollY <= target + 1) return;
      const html = document.documentElement;
      const prev = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      window.scrollTo(0, Math.max(0, target));
      html.style.scrollBehavior = prev;
    };
    const refresh = (keepInView) => {
      const snap = snapGrid(grid);
      displayedCount = PAGE_SIZE;
      applyGamesFilter();
      renderGamesList(false);
      if (keepInView) keepResultsInView();
      playGrid(grid, snap);
    };
    // Смена вида не уводит со строки, которую человек смотрел
    const gridAnchor = () => {
      const limit = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
      if (grid.getBoundingClientRect().top >= limit) return null;
      const el = [...grid.querySelectorAll('[data-key]')].find((c) => c.getBoundingClientRect().bottom > limit + 8);
      return el ? { key: el.dataset.key, top: el.getBoundingClientRect().top } : null;
    };
    const restoreAnchor = (a) => {
      if (!a) return;
      const el = [...grid.querySelectorAll('[data-key]')].find((c) => c.dataset.key === a.key);
      if (!el) return;
      const d = el.getBoundingClientRect().top - a.top;
      if (Math.abs(d) < 1) return;
      const html = document.documentElement;
      const prev = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      window.scrollBy(0, d);
      html.style.scrollBehavior = prev;
    };

    // Запрос, сортировка и взломщик сохраняются в адресе (?q=&sort=&cr=), чтобы ими можно было поделиться
    let urlTimer = 0;
    const syncUrl = () => {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(() => {
        try {
          const u = new URL(location.href);
          const q = (searchInput?.value || '').trim();
          if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
          if (gamesUi.sort !== 'default') u.searchParams.set('sort', gamesUi.sort); else u.searchParams.delete('sort');
          if (gamesUi.group) u.searchParams.set('cr', gamesUi.group); else u.searchParams.delete('cr');
          history.replaceState(history.state, '', u);
        } catch { /* например, file:// */ }
      }, 400);
    };
    try {
      const sp = new URLSearchParams(location.search);
      const q0 = sp.get('q');
      if (q0 && searchInput) { searchInput.value = q0; if (clearBtn) clearBtn.hidden = false; }
      const s0 = sp.get('sort');
      if (GAME_SORT_KEYS.includes(s0)) gamesUi.sort = s0;
      gamesUi.group = (sp.get('cr') || '').trim();
    } catch { /* без параметров */ }

    const onSearch = () => {
      if (clearBtn) clearBtn.hidden = !searchInput.value;
      refresh(true);
      syncUrl();
    };
    searchInput?.addEventListener('input', onSearch);

    // Esc очищает поиск, «/» — быстрый переход к поиску с любого места страницы
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchInput.value) {
        e.preventDefault();
        searchInput.value = '';
        onSearch();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !searchInput) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if ($('#lightbox')?.classList.contains('open')) return;
      e.preventDefault();
      searchInput.focus({ preventScroll: true });
      searchInput.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    });

    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      onSearch();
      searchInput?.focus();
    });

    // Быстрые фильтры
    const chips = $$('.games-chip[data-filter]');
    const setFilter = (f) => {
      gamesUi.filter = f;
      chips.forEach((c) => {
        const on = c.dataset.filter === f;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      updateChipsInd();
    };
    chips.forEach((chip) => chip.addEventListener('click', () => {
      setFilter(chip.dataset.filter);
      refresh(true);
    }));

    // Вид: плитка или список, выбор запоминается
    const setView = (v, animate = false) => {
      const next = v === 'list' ? 'list' : 'grid';
      const changed = grid.dataset.view !== next;
      gamesUi.view = next;
      try { localStorage.setItem('es-games-view', gamesUi.view); } catch { /* хранилище недоступно */ }
      $$('.games-view-btn').forEach((b) => {
        const on = b.dataset.view === gamesUi.view;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      updateViewInd();
      if (!changed) return;
      if (!animate || !gamesUi.loaded) { grid.dataset.view = next; return; }
      // Карточки перестраиваются каскадом, а прокрутка держится за ту же строку
      const snap = snapGrid(grid);
      const anchor = gridAnchor();
      grid.dataset.view = next;
      restoreAnchor(anchor);
      playGrid(grid, snap, { cascade: true, height: false });
    };
    $$('.games-view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view, true)));
    setView(gamesUi.view);

    // Сортировка и фильтр по взломщику: выпадающее меню, работает и с клавиатуры
    const sortWrap = $('#gamesSort');
    const sortBtn = $('#gamesSortBtn');
    const sortMenu = $('#gamesSortMenu');
    const setSort = (v) => {
      gamesUi.sort = GAME_SORT_KEYS.includes(v) ? v : 'default';
      try { localStorage.setItem('es-games-sort', gamesUi.sort); } catch { /* хранилище недоступно */ }
    };
    const setGroup = (v) => { gamesUi.group = v || ''; };
    const menuItems = () => $$('.games-sort-item', sortMenu).filter((b) => b.offsetParent !== null && b.getAttribute('aria-disabled') !== 'true');
    const focusChecked = () => {
      const items = menuItems();
      (items.find((b) => b.getAttribute('aria-checked') === 'true') || items[0])?.focus();
    };
    let menuOpen = false;
    const openMenu = () => {
      if (!sortMenu || menuOpen) return;
      menuOpen = true;
      syncSortUi();
      sortMenu.classList.remove('is-closing');
      sortMenu.hidden = false;
      // Пункты появляются коротким каскадом
      $$('.games-sort-item', sortMenu).filter((b) => !b.hidden).forEach((b, k) => b.style.setProperty('--k', Math.min(k, 14)));
      sortWrap.classList.add('open');
      sortBtn.setAttribute('aria-expanded', 'true');
    };
    const closeMenu = (restoreFocus) => {
      if (!sortMenu || !menuOpen) return;
      menuOpen = false;
      sortWrap.classList.remove('open');
      sortBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) sortBtn.focus();
      if (!canAnimate) { sortMenu.hidden = true; return; }
      // Меню сначала гаснет, потом скрывается
      sortMenu.classList.add('is-closing');
      wait(170).then(() => {
        if (menuOpen) return;
        sortMenu.hidden = true;
        sortMenu.classList.remove('is-closing');
      });
    };
    sortBtn?.addEventListener('click', () => (menuOpen ? closeMenu(false) : openMenu()));
    sortBtn?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); focusChecked(); }
      else if (e.key === 'Escape') closeMenu(false);
    });
    sortMenu?.addEventListener('keydown', (e) => {
      const items = menuItems();
      const i = items.indexOf(document.activeElement);
      const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(items.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', (e) => { if (sortWrap && !sortWrap.contains(e.target)) closeMenu(false); });
    sortMenu?.addEventListener('click', (e) => {
      const item = e.target.closest('.games-sort-item');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      if (item.dataset.sort) setSort(item.dataset.sort);
      else if ('group' in item.dataset) setGroup(item.dataset.group);
      closeMenu(true);
      refresh(true);
      syncUrl();
    });
    // Кнопка-метка выбранного взломщика рядом с фильтрами: клик снимает фильтр
    $('#gamesGroupChip')?.addEventListener('click', () => {
      setGroup('');
      refresh(true);
      syncUrl();
    });

    $('#gamesReset')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (clearBtn) clearBtn.hidden = true;
      setFilter('all');
      setGroup('');
      refresh(true);
      syncUrl();
      searchInput?.focus({ preventScroll: true });
    });

    // Догруженные карточки проявляются каскадом
    const appendMore = (count) => {
      const n = grid.children.length;
      displayedCount = count;
      renderGamesList(true);
      enterNodes([...grid.children].slice(n));
    };
    $('#gamesLoadMore')?.addEventListener('click', () => appendMore(displayedCount + PAGE_SIZE));
    $('#gamesShowAll')?.addEventListener('click', () => appendMore(filteredGames.length));

    // Клики внутри списка: копирование пароля и автокопирование при скачивании
    grid.addEventListener('click', (e) => {
      const dict = dictNow();
      const who = e.target.closest('.game-group');
      if (who) {
        setGroup(who.dataset.group);
        refresh(true);
        syncUrl();
        return;
      }
      const dl = e.target.closest('.game-dl-btn');
      if (dl) {
        // Переход по ссылке не отменяем — пароль просто окажется в буфере
        const pass = dl.dataset.pass;
        if (pass) copyText(pass).then((ok) => { if (ok) showToast(fmt(dict['games.passAuto'], { p: pass }), 3200); });
        return;
      }
      const pill = e.target.closest('.game-pass-pill');
      if (!pill || !pill.dataset.pass) return;
      const pass = pill.dataset.pass;
      copyText(pass).then((ok) => {
        if (!ok) return;
        const span = pill.querySelector('span');
        pill.classList.add('copied');
        if (span) span.textContent = dict['comm.done'];
        showToast(`${dict['games.passCopied']}: ${pass}`, 1800);
        setTimeout(() => {
          pill.classList.remove('copied');
          if (span) span.textContent = pass;
        }, 1600);
      });
    });

    // Загрузка данных
    const GIST_URL = 'https://gist.githubusercontent.com/LeoBanned/b314de5f9a3e2293b7e3c22136d49889/raw/cracks.json';
    const FALLBACK_URL = './data/cracks.json';
    const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });

    // Взломщики в меню — по числу релизов
    const buildCrackerList = () => {
      const list = $('#gamesCrackerList');
      const sec = $('#gamesCrackerSec');
      if (!list || !sec) return;
      const counts = new Map();
      allGames.forEach((g) => { if (g.group) counts.set(g.group, (counts.get(g.group) || 0) + 1); });
      const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || collate(a[0], b[0]));
      sec.hidden = !groups.length;
      const byCracker = $('.games-sort-item[data-sort="cracker"]');
      if (byCracker) byCracker.hidden = groups.length < 2;
      const dict = dictNow();
      list.innerHTML = [['', allGames.length], ...groups].map(([g, n]) => `<button type="button" class="games-sort-item" role="menuitemradio" aria-checked="false" data-group="${esc(g)}">${g ? `<span class="games-sort-name">${esc(g)}</span>` : `<span data-i18n="games.crackerAll">${dict['games.crackerAll']}</span>`}<b class="mono">${n}</b></button>`).join('');
      if (gamesUi.group && !counts.has(gamesUi.group)) gamesUi.group = '';
    };
    // Данные GitHub пришли позже первой отрисовки: обновляем даты, метки и порядок, не сбрасывая показанное
    const applyLateMeta = () => {
      const snap = snapGrid(grid);
      markNewest();
      if (gamesMeta === 'fail' && gamesUi.sort === 'popular') gamesUi.sort = 'default';
      applyGamesFilter();
      renderGamesList(false);
      playGrid(grid, snap);
    };

    getJson(GIST_URL)
      .catch(() => getJson(`${FALLBACK_URL}?v=8.2.0`))
      .then(async (data) => {
        const cracks = Array.isArray(data) ? data : (data?.cracks || []);
        allGames = prepareGames(cracks.filter((c) => c && c.name && c.url));
        // Даты и скачивания ждём недолго, чтобы порядок не перестраивался на глазах
        const meta = loadGamesMeta(allGames).then(
          () => { gamesMeta = 'ok'; },
          (err) => { gamesMeta = 'fail'; console.warn('GitHub assets meta unavailable:', err); }
        );
        await Promise.race([meta, new Promise((r) => setTimeout(r, 900))]);
        markNewest();
        buildCrackerList();
        if (gamesMeta === 'fail' && gamesUi.sort === 'popular') gamesUi.sort = 'default';
        gamesUi.loaded = true;
        const counts = { all: allGames.length, pinned: allGames.filter((g) => g.pinned).length, nopass: allGames.filter((g) => !g.pass).length };
        $$('[data-count-for]').forEach((el) => { el.textContent = counts[el.dataset.countFor] ?? ''; });
        // Пустые фильтры не показываем
        chips.forEach((c) => { if (c.dataset.filter !== 'all' && !counts[c.dataset.filter]) c.hidden = true; });
        // Заглушки гаснут, карточки проявляются на их месте
        const snap0 = snapGrid(grid);
        applyGamesFilter();
        renderGamesList(false);
        playGrid(grid, snap0);
        if (gamesMeta === 'wait') meta.then(applyLateMeta);
      })
      .catch((err) => {
        console.warn('Failed to load cracks catalog:', err);
        grid.setAttribute('aria-busy', 'false');
        grid.innerHTML = `<p class="games-empty">${dictNow()['games.loadErr']}</p>`;
        const f = $('#gamesFooter');
        if (f) f.hidden = true;
      });
  }

  /* ================= Запуск ================= */
  document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    splitText();
    initTitleGradient();
    initHeader();
    initScrollFx();
    initPointerFx();
    initSpotlight();
    initShowcase();
    initCompare();
    initReleases();
    initGames();
    initCopy();
    initCounters();
    runLoader().then(initReveal);
  });
})();
