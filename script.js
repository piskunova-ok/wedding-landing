/* Анна & Михаил — интерактив лендинга */
(function () {
  'use strict';

  // ---- Конфиг: всё, что легко менять ----
  // Порядок важен: сначала локальный сервер (node server.js), затем Netlify Function.
  // Первый ответивший JSON endpoint используется, 404/обрыв сети — пробуем следующий.
  var CONFIG = {
    weddingDate: '2026-09-24T16:00:00',
    endpoints: { rsvp: ['/api/rsvp', '/.netlify/functions/rsvp'] }
  };

  // Отправка с fallback: локальный API → Netlify Function
  function postRsvp(payload) {
    var urls = CONFIG.endpoints.rsvp;
    function attempt(i) {
      if (i >= urls.length) return Promise.reject(new Error('all-failed'));
      return fetch(urls[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().catch(function () { return null; })
          .then(function (data) {
            if (!res.ok && data === null) return attempt(i + 1); // 404 HTML статики — пробуем дальше
            return { ok: res.ok, data: data };
          });
      }).catch(function () { return attempt(i + 1); }); // обрыв сети — пробуем дальше
    }
    return attempt(0);
  }

  // ---- Навигация ----
  var nav = document.getElementById('nav');
  var burger = document.getElementById('burger');
  var navLinks = document.getElementById('navLinks');

  function onScroll() {
    if (window.scrollY > 40) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  navLinks.addEventListener('click', function (e) {
    if (e.target.closest('a')) nav.classList.remove('open');
  });

  // ---- Плавное появление при скролле ----
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('visible');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  // ---- Countdown ----
  var target = new Date(CONFIG.weddingDate).getTime();
  var dEl = document.getElementById('cd-days');
  var hEl = document.getElementById('cd-hours');
  var mEl = document.getElementById('cd-mins');
  var sEl = document.getElementById('cd-secs');
  var timer = document.getElementById('timer');
  var doneMsg = document.getElementById('countdownDone');

  function pad(n) { return String(n).padStart(2, '0'); }
  function tick() {
    var diff = target - Date.now();
    if (diff <= 0) {
      timer.style.display = 'none';
      doneMsg.hidden = false;
      clearInterval(iv);
      return;
    }
    var d = Math.floor(diff / 864e5);
    var h = Math.floor(diff / 36e5) % 24;
    var m = Math.floor(diff / 6e4) % 60;
    var s = Math.floor(diff / 1e3) % 60;
    dEl.textContent = pad(d);
    hEl.textContent = pad(h);
    mEl.textContent = pad(m);
    sEl.textContent = pad(s);
  }
  var iv = setInterval(tick, 1000);
  tick();

  // ---- Галерея + Lightbox ----
  var items = Array.prototype.slice.call(document.querySelectorAll('.g-item img'));
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lbImg');
  var idx = 0;

  function openLb(i) {
    idx = (i + items.length) % items.length;
    lbImg.src = items[idx].src;
    lbImg.alt = items[idx].alt;
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLb() {
    lb.hidden = true;
    document.body.style.overflow = '';
  }
  items.forEach(function (img, i) {
    img.closest('.g-item').addEventListener('click', function () { openLb(i); });
  });
  document.getElementById('lbClose').addEventListener('click', closeLb);
  document.getElementById('lbPrev').addEventListener('click', function (e) { e.stopPropagation(); openLb(idx - 1); });
  document.getElementById('lbNext').addEventListener('click', function (e) { e.stopPropagation(); openLb(idx + 1); });
  lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return;
    if (e.key === 'Escape') closeLb();
    if (e.key === 'ArrowLeft') openLb(idx - 1);
    if (e.key === 'ArrowRight') openLb(idx + 1);
  });

  // ---- RSVP ----
  var form = document.getElementById('rsvpForm');
  var sendBtn = document.getElementById('sendBtn');
  var errBox = document.getElementById('formError');
  var thanksYes = document.getElementById('thanksYes');
  var thanksNo = document.getElementById('thanksNo');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }
  function hideError() {
    errBox.hidden = true;
    errBox.textContent = '';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideError();

    var name = document.getElementById('fName').value.trim();
    var attendance = (form.querySelector('input[name="attendance"]:checked') || {}).value;
    var guests = parseInt(document.getElementById('fGuests').value, 10);
    var menuComment = document.getElementById('fMenu').value.trim();

    // Клиентская валидация
    if (name.length < 2) { showError('Пожалуйста, укажите имя и фамилию.'); return; }
    if (attendance !== 'yes' && attendance !== 'no') { showError('Пожалуйста, выберите ваш ответ.'); return; }
    if (!(guests >= 1 && guests <= 4)) { showError('Укажите количество гостей от 1 до 4.'); return; }
    if (menuComment.length > 500) { showError('Пожелания по меню — не более 500 символов.'); return; }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Отправляем…';

    postRsvp({ name: name, attendance: attendance, guests: guests, menuComment: menuComment })
      .then(function (result) {
        if (result.ok && result.data && result.data.success) {
          form.hidden = true;
          if (attendance === 'yes') thanksYes.hidden = false;
          else thanksNo.hidden = false;
          (thanksYes.hidden ? thanksNo : thanksYes).scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          var msg = (result.data && result.data.message) ||
            'Не удалось отправить ответ. Проверьте соединение и попробуйте ещё раз.';
          showError(msg);
          sendBtn.disabled = false;
          sendBtn.textContent = 'Отправить';
        }
      })
      .catch(function () {
        showError('Не удалось отправить ответ. Проверьте соединение и попробуйте ещё раз.');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Отправить';
      });
  });
})();
