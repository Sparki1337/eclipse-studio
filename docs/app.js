/* Eclipse Studio — сайт */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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

      const repeat = sessionStorage.getItem('es-visited') === '1';
      sessionStorage.setItem('es-visited', '1');
      const minTime = repeat ? 1500 : 2600;

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
      const steps = ['core_engine', 'steam_api', 'smoke_api', 'croclua', 'hypervisor', 'interface'];
      const start = performance.now();
      let loaded = document.readyState === 'complete';
      window.addEventListener('load', () => { loaded = true; }, { once: true });
      setTimeout(() => { loaded = true; }, 6000);
      let shown = 0;
      let skip = false;
      loader.addEventListener('click', () => { skip = true; });

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
    });
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
    let lastY = window.scrollY;

    burger?.addEventListener('click', () => {
      burger.classList.toggle('open');
      nav.classList.toggle('open');
    });
    $$('a', nav).forEach((a) => a.addEventListener('click', () => {
      burger.classList.remove('open'); nav.classList.remove('open');
    }));

    const onScroll = () => {
      const y = window.scrollY;
      header.classList.toggle('scrolled', y > 20);
      document.querySelector('.scroll-hint')?.classList.toggle('gone', y > 40);
      const menuOpen = nav.classList.contains('open');
      header.classList.toggle('hide', !menuOpen && y > 700 && y > lastY + 2);
      if (y < lastY - 2) header.classList.remove('hide');
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const links = $$('a[href^="#"]', nav);
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === `#${e.target.id}`));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach((l) => { const s = $(l.getAttribute('href')); if (s) io.observe(s); });
  }

  /* ================= Эффекты прокрутки ================= */
  function initScrollFx() {
    const hw = $('#heroWindow');
    const footer = $('.footer');
    let ticking = false;
    const update = () => {
      ticking = false;
      const vh = window.innerHeight;
      if (hw) {
        const r = hw.getBoundingClientRect();
        const p = clamp(1 - (r.top - vh * .25) / (vh * .6), 0, 1);
        hw.style.setProperty('--p', p.toFixed(3));
      }
      if (footer) {
        const r = footer.getBoundingClientRect();
        footer.style.setProperty('--fp', clamp(1 - (r.top - vh * .2) / (vh * .8), 0, 1).toFixed(3));
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
      img.src = it.dataset.img;
      img.alt = it.dataset.title;
      img.decoding = 'async';
      if (i === 0) img.classList.add('on');
      frames.appendChild(img);
      return img;
    });

    let current = 0;
    function setActive(i) {
      if (i === current) return;
      const prev = current;
      current = i;
      items.forEach((it, k) => it.classList.toggle('is-active', k === i));
      imgs.forEach((im, k) => { im.classList.remove('off'); if (k !== i && k !== prev) im.classList.remove('on'); });
      imgs[prev].classList.remove('on'); imgs[prev].classList.add('off');
      void imgs[i].offsetWidth;
      imgs[i].classList.add('on');
      setTimeout(() => imgs[prev].classList.remove('off'), 900);
      label.textContent = items[i].dataset.title;
      count.textContent = `${String(i + 1).padStart(2, '0')} / ${total}`;
      desc.style.opacity = 0;
      setTimeout(() => { desc.textContent = items[i].dataset.desc; desc.style.opacity = 1; }, 180);
    }

    items.forEach((it, i) => it.addEventListener('click', () => setActive(i)));

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(items.indexOf(e.target)); });
    }, { rootMargin: window.innerWidth < 960 ? '-62% 0px -30% 0px' : '-48% 0px -48% 0px' });
    items.forEach((it) => io.observe(it));

    // Лайтбокс
    const lb = $('#lightbox'), lbImg = $('#lightboxImg'), lbT = $('#lightboxTitle'), lbD = $('#lightboxDesc');
    let lbIndex = 0;
    const show = (i) => {
      lbIndex = (i + items.length) % items.length;
      const it = items[lbIndex];
      lbImg.style.opacity = 0;
      setTimeout(() => {
        lbImg.src = it.dataset.img; lbImg.alt = it.dataset.title;
        lbT.textContent = it.dataset.title; lbD.textContent = it.dataset.desc;
        lbImg.style.opacity = 1;
      }, lb.classList.contains('open') ? 150 : 0);
    };
    const open = () => { show(current); lb.classList.add('open'); lb.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; };
    const close = () => { lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; };
    $('#showcaseWindow').addEventListener('click', open);
    $$('[data-close]', lb).forEach((b) => b.addEventListener('click', close));
    $('#lbPrev').addEventListener('click', () => show(lbIndex - 1));
    $('#lbNext').addEventListener('click', () => show(lbIndex + 1));
    window.addEventListener('keydown', (e) => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(lbIndex - 1);
      if (e.key === 'ArrowRight') show(lbIndex + 1);
    });
  }

  /* ================= Сравнение ================= */
  function initCompare() {
    const box = $('#compareBox');
    if (!box) return;
    let drag = false, intro = null;
    const set = (pct) => box.style.setProperty('--pos', `${clamp(pct, 2, 98)}%`);
    const fromEvent = (e) => {
      const r = box.getBoundingClientRect();
      set(((e.clientX - r.left) / r.width) * 100);
    };
    box.addEventListener('pointerdown', (e) => {
      drag = true; box.classList.add('drag'); cancelAnimationFrame(intro);
      box.setPointerCapture(e.pointerId); fromEvent(e);
    });
    box.addEventListener('pointermove', (e) => { if (drag) fromEvent(e); });
    const stop = () => { drag = false; box.classList.remove('drag'); };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    box.addEventListener('keydown', () => {});

    // Демонстрационный проход ползунка
    if (reduced) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      const keys = [50, 22, 78, 50], dur = 2400, t0 = performance.now() + 500;
      const run = (now) => {
        const k = clamp((now - t0) / dur, 0, 1);
        const seg = Math.min(2, Math.floor(k * 3));
        const local = k * 3 - seg;
        const e = local < .5 ? 4 * local ** 3 : 1 - Math.pow(-2 * local + 2, 3) / 2;
        set(keys[seg] + (keys[seg + 1] - keys[seg]) * e);
        if (k < 1 && !drag) intro = requestAnimationFrame(run);
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
      'games.lead': 'База релизов от DenuvOwO и ARTIFACT. Прямые ссылки на скачивание архивов и пароли в один клик.',
      'games.searchPlaceholder': 'Поиск по названию (например, Persona, Sonic, FC 27)...',
      'games.count': 'релизов в базе',
      'games.found': 'найдено',
      'games.noPass': 'Без пароля',
      'games.pass': 'Пароль:',
      'games.copyPass': 'Скопировать пароль',
      'games.passCopied': 'Пароль скопирован',
      'games.download': 'Скачать',
      'games.more': 'Показать ещё',
      'games.empty': 'Игры по вашему запросу не найдены.',
      'games.allLoaded': 'Все игры загружены',
      'header.download': 'Скачать',
      'hero.tag': 'Eclipse Studio',
      'hero.title1': 'Игровая лаборатория',
      'hero.title2': 'для Steam.',
      'hero.lead': 'Приложение на Rust и Tauri v2: фиксы онлайна, DLC, сохранения, манифесты CrocLua и гипервизор взломы — в одном окне.',
      'hero.download': 'Скачать',
      'hero.modules': 'Смотреть модули',
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
      'compare.diffOrig1': 'Фиксированные градиенты',
      'compare.diffOrig2': 'Статичные системные иконки Windows',
      'compare.diffOrig3': 'Смешанные внешние вызовы путей',
      'compare.diffOrig4': 'Отсутвие загрузки и части кастомизации',
      'compare.diffNew1': '9 тем, включая белую',
      'compare.diffNew2': 'Векторные иконки Lucide',
      'compare.diffNew3': 'Заставка-мозаика',
      'compare.diffNew4': 'Нативный проводник Tauri',
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
      'games.lead': 'Release database by DenuvOwO and ARTIFACT. Direct archive download links and one-click passwords.',
      'games.searchPlaceholder': 'Search by title (e.g., Persona, Sonic, FC 27)...',
      'games.count': 'releases available',
      'games.found': 'found',
      'games.noPass': 'No password',
      'games.pass': 'Password:',
      'games.copyPass': 'Copy password',
      'games.passCopied': 'Password copied',
      'games.download': 'Download',
      'games.more': 'Show more',
      'games.empty': 'No games matching your search.',
      'games.allLoaded': 'All games loaded',
      'header.download': 'Download',
      'hero.tag': 'Eclipse Studio',
      'hero.title1': 'Gaming laboratory',
      'hero.title2': 'for Steam.',
      'hero.lead': 'Built with Rust & Tauri v2: online fixes, DLCs, save games, CrocLua manifests and hypervisor unlocks — all in one window.',
      'hero.download': 'Download',
      'hero.modules': 'Explore modules',
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
      'compare.diffOrig1': 'Fixed static gradients',
      'compare.diffOrig2': 'Legacy Windows system icons',
      'compare.diffOrig3': 'Mixed external path dependencies',
      'compare.diffOrig4': 'No download vault & limited styling',
      'compare.diffNew1': '9 themes, including clean light mode',
      'compare.diffNew2': 'Crisp Lucide vector icons',
      'compare.diffNew3': 'Mosaic intro animation',
      'compare.diffNew4': 'Native Tauri file dialogs',
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
      { title: 'Главная', fullTitle: 'Главная страница', p: 'Сводка состояния и быстрый доступ к модулям.', desc: 'Стартовый экран со сводкой состояния компонентов и быстрым переходом к активным модулям.' },
      { title: 'Online Fix', fullTitle: 'Universal Online Fix', p: 'Сетевой кооператив и лобби Spacewar.', desc: 'Анализ исполняемых файлов, эмуляторы Steam, лобби Spacewar и фиксы Epic Online Services.' },
      { title: 'Сохранения', fullTitle: 'Менеджер сохранений', p: 'Поиск, бэкап и восстановление прогресса.', desc: 'Поиск прогресса по 15+ путям Windows, архивация в ZIP/RAR и побайтовое восстановление.' },
      { title: 'DLC Unlocker', fullTitle: 'DLC Unlocker', p: 'Выборочно — через SmokeAPI и CreamAPI.', desc: 'Выборочная разблокировка дополнений Steam через SmokeAPI и CreamAPI.' },
      { title: 'CrocLua', fullTitle: 'CrocLua и манифесты', p: 'Игры в библиотеке Steam через манифесты.', desc: 'Добавление игр в библиотеку Steam через Ryuu и HubCap с поддержкой Millennium.' },
      { title: 'Гипервизор', fullTitle: 'Гипервизор: запуск игр', p: 'Библиотека и запуск игр от DenuvOwO\\ARTIFACT через профили KVC / DRV.', desc: 'Изолированный запуск игр с драйверными профилями KVC и DRV.' },
      { title: 'Античиты', fullTitle: 'Гипервизор: античиты', p: 'Поиск и удаление античитов.', desc: 'Аудит служб, драйверов и остаточных файлов 12 популярных античитов.' },
      { title: 'VBS & HVCI', fullTitle: 'Гипервизор: VBS и HVCI', p: 'Настройка гипервизора.', desc: 'Управление Virtualization-based Security, изоляцией ядра, DSE и тестовым режимом.' },
      { title: 'Crack Vault', fullTitle: 'Crack Vault', p: 'Каталог с кряками игр от DenuvOwO\\ARTIFACT.', desc: 'Каталог актуальных релизов с паролями и 6-поточным загрузчиком.' },
      { title: 'Утилиты', fullTitle: 'Утилиты', p: 'CirnoDownloader, Sigma, Zapret2.', desc: 'Хаб внешних инструментов: CirnoDownloader, Sigma, Zapret2 и инструкции по настройке.' },
      { title: 'Настройки', fullTitle: 'Настройки', p: 'Темы, акценты, масштаб и язык.', desc: '9 тем, 12 акцентов, масштабирование шрифта и мультиязычность.' },
      { title: 'Telegram Hub', fullTitle: 'Telegram Hub', p: 'Каналы проекта и поддержка.', desc: 'Все официальные сообщества, канал обновлений и поддержка в одном окне.' },
    ],
    en: [
      { title: 'Home', fullTitle: 'Home Screen', p: 'Status summary and quick access to modules.', desc: 'Startup dashboard summarizing component status with quick access to active modules.' },
      { title: 'Online Fix', fullTitle: 'Universal Online Fix', p: 'Online co-op and Spacewar lobbies.', desc: 'Executable analysis, Steam emulators, Spacewar lobbies, and Epic Online Services fixes.' },
      { title: 'Save Manager', fullTitle: 'Save Game Manager', p: 'Discovery, backup, and restore of progress.', desc: 'Progress discovery across 15+ Windows paths, ZIP/RAR archiving, and byte-accurate recovery.' },
      { title: 'DLC Unlocker', fullTitle: 'DLC Unlocker', p: 'Selective unlock via SmokeAPI & CreamAPI.', desc: 'Selective Steam DLC unlocking powered by SmokeAPI and CreamAPI.' },
      { title: 'CrocLua', fullTitle: 'CrocLua & Manifests', p: 'Steam library games via manifests.', desc: 'Add games to Steam library via Ryuu and HubCap with Millennium support.' },
      { title: 'Hypervisor', fullTitle: 'Hypervisor: Game Launch', p: 'Launch DenuvOwO\\ARTIFACT games via KVC / DRV.', desc: 'Isolated game execution using specialized KVC and DRV driver profiles.' },
      { title: 'Anticheats', fullTitle: 'Hypervisor: Anticheats', p: 'Scan and remove anticheat services.', desc: 'Audit services, drivers, and residual files from 12 popular anticheat systems.' },
      { title: 'VBS & HVCI', fullTitle: 'Hypervisor: VBS & HVCI', p: 'Hypervisor & security configuration.', desc: 'Manage Virtualization-based Security, core isolation, DSE, and test mode.' },
      { title: 'Crack Vault', fullTitle: 'Crack Vault', p: 'Game cracks by DenuvOwO\\ARTIFACT.', desc: 'Catalog of current releases with passwords and multi-threaded downloader.' },
      { title: 'Utilities', fullTitle: 'Utilities', p: 'CirnoDownloader, Sigma, Zapret2.', desc: 'External tool hub: CirnoDownloader, Sigma, Zapret2 and setup guides.' },
      { title: 'Settings', fullTitle: 'Settings', p: 'Themes, accents, zoom, and language.', desc: '9 themes, 12 accents, typography scaling, and multilingual support.' },
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
    });

    const dict = I18N[lang];
    $$('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      const val = dict[key];
      if (!val) return;

      if (el.classList.contains('line')) {
        const parent = el.closest('[data-split]');
        if (parent && parent.classList.contains('in')) {
          el.innerHTML = val.split(/\s+/).map((w) => `<span class="w"><span style="transform:none">${w}</span></span>`).join('');
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
      const [attr, key] = (el.dataset.i18nAttr || '').split(':');
      if (attr && key && dict[key]) {
        el.setAttribute(attr, dict[key]);
      }
    });

    // Обновление каталога игр
    if (typeof renderGamesList === 'function' && allGames.length) {
      renderGamesList(false);
    }

    // Обновление статуса синхронизации
    const sync = $('#syncStatus');
    if (sync && (syncState.ok + syncState.fail >= 2)) {
      sync.lastElementChild.textContent = syncState.fail === 2
        ? dict['sync.err']
        : dict['sync.ok'];
    }
  }

  function initLanguage() {
    $$('#langSwitch .lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setLanguage(btn.dataset.lang);
      });
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
      const file = assets.find((a) => /\.exe$/i.test(a.name)) || assets.find((a) => /\.zip$/i.test(a.name)) || assets[0];
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
      <a href="${r.url}" class="ver-item" target="_blank" rel="noopener noreferrer" title="${r.tag}">
        <div class="ver-item-left">
          <span class="ver-item-tag mono">${r.tag}</span>
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

    // Eclipse Studio
    fetchAllReleases('Sparki1337/eclipse-studio')
      .then((releases) => {
        syncState.ok++;
        cachedEclipseReleases = releases;
        renderReleasesUI('eclipse', releases);
      })
      .catch(() => {
        syncState.fail++;
        const fallback = [
          { tag: 'v6.2.0', rawDate: '2026-10-12T12:00:00Z', rawBytes: 44774195, url: 'https://github.com/Sparki1337/eclipse-studio/releases/latest', fallbackSize: '42.7 МБ' },
          { tag: 'v6.1.0', rawDate: '2026-10-12T10:00:00Z', rawBytes: 44774195, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/6.1.0', fallbackSize: '42.7 МБ' },
          { tag: 'v6.0.0', rawDate: '2026-10-12T08:00:00Z', rawBytes: 44564480, url: 'https://github.com/Sparki1337/eclipse-studio/releases/tag/6.0.0', fallbackSize: '42.5 МБ' },
        ];
        cachedEclipseReleases = fallback;
        renderReleasesUI('eclipse', fallback);
      })
      .finally(done);

    // Crocodile Gena Studio
    fetchAllReleases('LeoBanned/crocodile-gena-studio-releases')
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
    const toast = $('#toast');
    let timer;
    $$('.copy-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const doneText = I18N[currentLang]?.['comm.done'] || 'Готово';
      const copiedText = I18N[currentLang]?.['comm.copied'] || 'Ссылка скопирована';
      const defaultText = I18N[currentLang]?.['comm.copy'] || 'Копировать';
      btn.textContent = doneText;
      btn.classList.add('ok');
      toast.textContent = copiedText;
      toast.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => {
        btn.textContent = defaultText;
        btn.classList.remove('ok');
        toast.classList.remove('show');
      }, 1800);
    }));
  }

  /* ================= Каталог кряков (Crack Vault) ================= */
  let allGames = [];
  let filteredGames = [];
  let displayedCount = 16;
  const PAGE_SIZE = 16;

  function cleanGameName(name) {
    if (!name) return '';
    return name.replace(/[\uFFFD]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function renderGamesList(append = false) {
    const grid = $('#gamesGrid');
    const empty = $('#gamesEmpty');
    const footer = $('#gamesFooter');
    const badge = $('#gamesCountBadge');
    const moreBtn = $('#gamesLoadMore');
    const moreCount = $('#gamesMoreCount');
    const dict = I18N[currentLang] || I18N.ru;

    if (!grid) return;

    if (!filteredGames.length) {
      grid.innerHTML = '';
      if (empty) empty.hidden = false;
      if (footer) footer.hidden = true;
      if (badge) badge.textContent = `0 ${dict['games.found']}`;
      return;
    }

    if (empty) empty.hidden = true;
    const isSearching = ($('#gamesSearch')?.value || '').trim().length > 0;
    if (badge) {
      badge.textContent = isSearching
        ? `${filteredGames.length} ${dict['games.found']}`
        : `${allGames.length} ${dict['games.count']}`;
    }

    const toShow = filteredGames.slice(0, displayedCount);

    if (!append) {
      grid.innerHTML = '';
    }

    const startIdx = append ? grid.children.length : 0;
    const slice = toShow.slice(startIdx);

    const frag = document.createDocumentFragment();
    slice.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'game-card';
      const cleanName = cleanGameName(item.name);
      const build = item.build ? item.build.trim() : '';
      const pass = item.password ? item.password.trim() : '';

      const passHtml = pass
        ? `<div class="game-pass-wrap">
             <span class="game-pass-label">${dict['games.pass']}</span>
             <button type="button" class="game-pass-pill mono" data-pass="${pass}" title="${dict['games.copyPass']}">
               <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
               <span>${pass}</span>
             </button>
           </div>`
        : `<span class="game-no-pass mono">${dict['games.noPass']}</span>`;

      card.innerHTML = `
        <div class="game-card-body">
          <h3 class="game-name" title="${cleanName}">${cleanName}</h3>
          ${build ? `<span class="game-build mono">${build}</span>` : ''}
          <div class="game-meta">
            ${passHtml}
          </div>
        </div>
        <div class="game-card-action">
          <a href="${item.url}" class="btn btn-sm btn-light game-dl-btn" target="_blank" rel="noopener noreferrer" download>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14"></path>
            </svg>
            <span>${dict['games.download']}</span>
          </a>
        </div>
      `;
      frag.appendChild(card);
    });

    grid.appendChild(frag);

    const remaining = filteredGames.length - displayedCount;
    if (footer) {
      if (remaining > 0) {
        footer.hidden = false;
        if (moreBtn) moreBtn.disabled = false;
        if (moreCount) moreCount.textContent = `(+${Math.min(remaining, PAGE_SIZE)})`;
      } else {
        footer.hidden = true;
      }
    }
  }

  function initGames() {
    const searchInput = $('#gamesSearch');
    const clearBtn = $('#gamesSearchClear');
    const loadMoreBtn = $('#gamesLoadMore');
    const grid = $('#gamesGrid');
    const toast = $('#toast');

    // Делегирование клика копирования пароля
    grid?.addEventListener('click', async (e) => {
      const passBtn = e.target.closest('.game-pass-pill');
      if (!passBtn) return;
      const pass = passBtn.dataset.pass;
      if (!pass) return;

      try { await navigator.clipboard.writeText(pass); }
      catch {
        const ta = Object.assign(document.createElement('textarea'), { value: pass });
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }

      const dict = I18N[currentLang] || I18N.ru;
      passBtn.classList.add('copied');
      const span = passBtn.querySelector('span');
      const origText = span ? span.textContent : pass;
      if (span) span.textContent = dict['comm.done'];
      if (toast) {
        toast.textContent = `${dict['games.passCopied']}: ${pass}`;
        toast.classList.add('show');
      }

      setTimeout(() => {
        passBtn.classList.remove('copied');
        if (span) span.textContent = origText;
        if (toast) toast.classList.remove('show');
      }, 1600);
    });

    // Фильтрация поиска
    const filterGames = () => {
      const q = (searchInput?.value || '').trim().toLowerCase();
      if (clearBtn) clearBtn.hidden = !q;
      displayedCount = PAGE_SIZE;
      if (!q) {
        filteredGames = [...allGames];
      } else {
        filteredGames = allGames.filter((g) => {
          const name = (g.name || '').toLowerCase();
          const build = (g.build || '').toLowerCase();
          return name.includes(q) || build.includes(q);
        });
      }
      renderGamesList(false);
    };

    searchInput?.addEventListener('input', filterGames);

    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearBtn.hidden = true;
      filterGames();
      searchInput?.focus();
    });

    loadMoreBtn?.addEventListener('click', () => {
      displayedCount += PAGE_SIZE;
      renderGamesList(true);
    });

    // Загрузка данных
    const GIST_URL = 'https://gist.githubusercontent.com/LeoBanned/b314de5f9a3e2293b7e3c22136d49889/raw/cracks.json';
    const FALLBACK_URL = './data/cracks.json';

    fetch(GIST_URL, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(() => fetch(`${FALLBACK_URL}?v=6.2.0`, { cache: 'no-store' }).then((r) => r.json()))
      .then((data) => {
        const cracks = Array.isArray(data) ? data : (data?.cracks || []);
        allGames = cracks.filter((c) => c && c.name && c.url);
        filteredGames = [...allGames];
        renderGamesList(false);
      })
      .catch((err) => {
        console.warn('Failed to load cracks catalog:', err);
        const g = $('#gamesGrid');
        if (g) g.innerHTML = '<p class="games-empty">Не удалось загрузить каталог игр.</p>';
      });
  }

  /* ================= Запуск ================= */
  document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    splitText();
    initHeader();
    initScrollFx();
    initPointerFx();
    initShowcase();
    initCompare();
    initReleases();
    initGames();
    initCopy();
    initCounters();
    runLoader().then(initReveal);
  });
})();
