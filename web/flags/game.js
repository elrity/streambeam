// World Flags: one flag, three names, beat the clock.
(function () {
  const $ = id => document.getElementById(id);
  const QUESTIONS = 20, LIVES = 3;
  const LEVELS = [
    { name: 'Starter', color: 'var(--l1)', time: 10, mul: 1 },
    { name: 'Easy', color: 'var(--l2)', time: 8, mul: 1.25 },
    { name: 'Medium', color: 'var(--l3)', time: 6, mul: 1.5 },
    { name: 'Hard', color: 'var(--l4)', time: 4, mul: 1.75 },
    { name: 'Expert', color: 'var(--l5)', time: 2, mul: 2 },
  ];
  // Less time per flag scores more.
  const TIME_MUL = { 10: 1, 8: 1.2, 6: 1.45, 4: 1.75, 2: 2.2 };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('wf-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('wf-' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const FLAGS = window.FLAGS.map(f => ({ ...f, hues: hueSet(f.k) }));
  let level = store.get('level', 1);
  let seconds = store.get('time', LEVELS[level - 1].time);
  let musicOn = store.get('music', true), sfxOn = store.get('sfx', true);
  Sound.setMusic(musicOn); Sound.setSfx(sfxOn);

  // ---------------- Menu ----------------
  function buildMenu() {
    const box = $('levels');
    box.innerHTML = '';
    LEVELS.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'level' + (level === i + 1 ? ' sel' : '');
      b.style.setProperty('--c', L.color);
      b.innerHTML = `<b>${i + 1}</b><small>${L.name}</small><span class="dots">${'★'.repeat(i + 1)}</span>`;
      b.onclick = () => {
        level = i + 1; store.set('level', level);
        setTime(L.time);
        Sound.play('select', i);
        buildMenu();
      };
      box.appendChild(b);
    });
    $('time').value = seconds;
    $('timeLabel').textContent = seconds + ' s';
    const best = store.get(`best-${level}-${seconds}`, 0);
    $('bestLine').textContent = best ? `🏆 Best on level ${level} at ${seconds} s: ${best.toLocaleString()}` : `Level ${level}: ${LEVELS[level - 1].name} flags · ${seconds} s per flag`;
  }
  function setTime(s) { seconds = s; store.set('time', s); $('time').value = s; $('timeLabel').textContent = s + ' s'; }

  let lastSlide = seconds;
  $('time').addEventListener('input', e => {
    const v = +e.target.value;
    if (v !== lastSlide) { lastSlide = v; Sound.play('slide'); }
    setTime(v); buildMenu();
  });
  $('musicBtn').onclick = () => {
    musicOn = !musicOn; store.set('music', musicOn); Sound.setMusic(musicOn);
    $('musicBtn').classList.toggle('on', musicOn); Sound.play('click');
    if (musicOn) Sound.music(current === 'game' ? 'game' : 'menu');
  };
  $('sfxBtn').onclick = () => {
    sfxOn = !sfxOn; store.set('sfx', sfxOn); Sound.setSfx(sfxOn);
    $('sfxBtn').classList.toggle('on', sfxOn); Sound.play('click');
  };
  $('musicBtn').classList.toggle('on', musicOn);
  $('sfxBtn').classList.toggle('on', sfxOn);

  // Browsers only allow sound after the first touch: start the menu music then.
  const firstTouch = () => { Sound.unlock(); if (current !== 'game') Sound.music('menu'); };
  document.addEventListener('pointerdown', firstTouch, { once: true });

  let current = 'menu';
  function show(id) {
    current = id;
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  }

  // ---------------- Game ----------------
  let G = null, raf = 0;

  function startGame() {
    Sound.play('start');
    Sound.music('game');
    const pool = shuffle(FLAGS.filter(f => f.l === level));
    // If a level ever has fewer flags than questions, top it up from the level below.
    if (pool.length < QUESTIONS) pool.push(...shuffle(FLAGS.filter(f => f.l === Math.max(1, level - 1) && !pool.includes(f))));
    G = { queue: pool.slice(0, QUESTIONS), n: 0, score: 0, lives: LIVES, streak: 0, best: 0, correct: 0, times: [], missed: [], locked: true };
    $('score').textContent = '0';
    $('stage').innerHTML = '';
    renderHearts();
    renderStreak();
    show('game');
    setTimeout(nextQuestion, 250);
  }

  function nextQuestion() {
    if (!G) return;
    if (G.n >= G.queue.length || G.lives <= 0) return endGame();
    const flag = G.queue[G.n];
    const options = shuffle([flag, ...distractors(flag)]);
    G.cur = { flag, options, start: 0, left: seconds, lastTick: Math.ceil(seconds) };
    $('progress').textContent = `${G.n + 1} / ${G.queue.length}`;

    // Old flag slides out to the left, the new one comes in from the right.
    const stage = $('stage');
    const old = stage.querySelector('.flag-card:not(.leave)');
    if (old) {
      old.classList.add('leave');
      Sound.play('whoosh');
      setTimeout(() => old.remove(), 500);
    }
    const card = document.createElement('div');
    card.className = 'flag-card enter';
    card.innerHTML = `<img src="img/${flag.c}.svg" alt="Which country's flag is this?" draggable="false">`;
    stage.appendChild(card);
    G.card = card;
    const next = G.queue[G.n + 1];
    if (next) new Image().src = `img/${next.c}.svg`;

    const box = $('choices');
    box.innerHTML = '';
    box.classList.remove('locked');
    options.forEach(o => {
      const b = document.createElement('button');
      b.className = 'choice';
      b.textContent = o.n;
      b.onclick = () => answer(o, b);
      box.appendChild(b);
    });
    G.locked = false;
    G.cur.start = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function loop(now) {
    if (!G || G.locked || G.paused) return;
    const left = Math.max(0, seconds - (now - G.cur.start) / 1000);
    G.cur.left = left;
    const frac = left / seconds;
    const fill = $('timerFill');
    fill.style.transform = `scaleX(${frac})`;
    fill.className = 'timer-fill' + (frac < 0.3 ? ' danger' : frac < 0.6 ? ' warn' : '');
    $('timerNum').textContent = left.toFixed(left < 3 ? 1 : 0);
    const whole = Math.ceil(left);
    if (whole < G.cur.lastTick) {
      G.cur.lastTick = whole;
      if (whole <= 3 && whole > 0) Sound.play('tick', whole <= 1);
    }
    if (left <= 0) return answer(null, null);
    raf = requestAnimationFrame(loop);
  }

  function answer(choice, btn) {
    if (!G || G.locked) return;
    G.locked = true;
    cancelAnimationFrame(raf);
    $('choices').classList.add('locked');
    const { flag } = G.cur;
    const used = (performance.now() - G.cur.start) / 1000;
    const buttons = [...$('choices').children];
    const right = buttons[G.cur.options.indexOf(flag)];

    if (choice === flag) {
      Sound.play('click');
      Sound.play('correct');
      G.streak++; G.best = Math.max(G.best, G.streak); G.correct++; G.times.push(used);
      // Points: base + speed bonus, times the streak, the level and the timer.
      const speed = Math.max(0, 1 - used / seconds);
      const streakMul = Math.min(3, 1 + (G.streak - 1) * 0.25);
      const pts = Math.round((100 + 150 * speed) * streakMul * LEVELS[level - 1].mul * TIME_MUL[seconds]);
      G.score += pts;
      btn.classList.add('good');
      G.card.classList.add('good');
      popup(`+${pts}`, speed > 0.7 ? '#ffd23f' : '#2ee59d', speed > 0.7 ? ' ⚡' : '');
      if (G.streak >= 3) Sound.play('combo', G.streak);
      const s = $('score');
      s.textContent = G.score.toLocaleString();
      s.classList.remove('bump'); void s.offsetWidth; s.classList.add('bump');
    } else {
      if (choice) { Sound.play('click'); Sound.play('wrong'); btn.classList.add('bad'); }
      else Sound.play('timeout');
      if (navigator.vibrate) navigator.vibrate(choice ? 120 : [60, 40, 60]);
      G.streak = 0; G.lives--; G.missed.push(flag);
      right.classList.add('good');
      G.card.classList.add('bad');
      popup(choice ? 'Wrong!' : "Time's up!", '#ff4d6d', '');
      renderHearts(true);
    }
    buttons.forEach(b => { if (b !== btn && b !== right) b.classList.add('dim'); });
    renderStreak();
    G.n++;
    setTimeout(nextQuestion, choice === flag ? 750 : 1300);
  }

  function endGame() {
    cancelAnimationFrame(raf);
    const g = G; G = null;
    let score = g.score;
    const perfect = g.lives === LIVES && g.correct === g.queue.length;
    if (perfect) score += Math.round(1000 * LEVELS[level - 1].mul * TIME_MUL[seconds]);
    const key = `best-${level}-${seconds}`;
    const prev = store.get(key, 0);
    const isBest = score > prev;
    if (isBest) store.set(key, score);

    const ratio = g.correct / g.queue.length;
    const stars = ratio >= 0.95 ? 3 : ratio >= 0.75 ? 2 : ratio >= 0.5 ? 1 : 0;
    $('resTitle').textContent = g.lives <= 0 ? 'Out of hearts!' : perfect ? 'PERFECT! 🎉' : stars >= 2 ? 'Great game!' : 'Good try!';
    $('stars').innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? '' : 'off'}" style="animation-delay:${0.2 + i * 0.2}s">⭐</span>`).join('');
    $('resScore').textContent = score.toLocaleString();
    $('resBest').textContent = isBest ? '🏆 New high score!' : perfect ? `Perfect bonus included · best ${prev.toLocaleString()}` : `Best: ${prev.toLocaleString()}`;
    $('resCorrect').textContent = `${g.correct}/${g.queue.length}`;
    $('resStreak').textContent = g.best;
    $('resSpeed').textContent = g.times.length ? (g.times.reduce((a, b) => a + b, 0) / g.times.length).toFixed(1) : '–';
    $('resMissed').innerHTML = g.missed.length
      ? g.missed.map(f => `<figure><img src="img/${f.c}.svg" alt="">${f.n}</figure>`).join('')
      : '';
    show('results');
    Sound.play('end', stars >= 2 || isBest);
    Sound.music('menu');
  }

  function quitToMenu() {
    cancelAnimationFrame(raf);
    G = null;
    Sound.play('click');
    Sound.music('menu');
    buildMenu();
    show('menu');
  }

  // ---------------- Helpers ----------------
  function distractors(flag) {
    const others = FLAGS.filter(f => f !== flag);
    let ranked;
    if (level >= 4) {
      // Hard levels: the wrong answers have similar colours (and often the same continent).
      ranked = others.map(f => ({ f, s: similarity(flag, f) + Math.random() * 0.15 })).sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.f);
    } else if (level === 3) {
      ranked = shuffle(others.filter(f => f.r === flag.r));
    } else if (level === 2) {
      ranked = Math.random() < 0.5 ? shuffle(others.filter(f => f.r === flag.r)) : shuffle(others);
    } else {
      ranked = shuffle(others);
    }
    const pick = shuffle(ranked).slice(0, 2);
    while (pick.length < 2) { const f = others[Math.floor(Math.random() * others.length)]; if (!pick.includes(f)) pick.push(f); }
    return pick;
  }

  function similarity(a, b) {
    const inter = [...a.hues].filter(h => b.hues.has(h)).length;
    const union = new Set([...a.hues, ...b.hues]).size || 1;
    return inter / union + (a.r === b.r ? 0.3 : 0);
  }

  function hueSet(colors) {
    const s = new Set();
    for (const hex of colors) {
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
      if (l > 0.88) { s.add('white'); continue; }
      if (l < 0.13) { s.add('black'); continue; }
      if (d < 0.12) { s.add('grey'); continue; }
      let h;
      if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      s.add(h < 15 || h >= 340 ? 'red' : h < 40 ? 'orange' : h < 70 ? 'yellow' : h < 170 ? 'green' : h < 260 ? 'blue' : 'purple');
    }
    return s;
  }

  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function renderHearts(lostOne) {
    $('hearts').innerHTML = Array.from({ length: LIVES }, (_, i) =>
      `<span class="${i < G.lives ? '' : 'lost'}${lostOne && i === G.lives ? ' pop' : ''}">❤️</span>`).join('');
  }
  function renderStreak() {
    const el = $('streak');
    const mul = Math.min(3, 1 + Math.max(0, G.streak - 1) * 0.25);
    el.textContent = G.streak >= 2 ? `🔥 Streak ${G.streak} · x${mul.toFixed(2).replace(/0$/, '')}` : '🔥 x1';
    el.classList.toggle('hot', G.streak >= 2);
  }
  function popup(text, color, extra) {
    const p = $('popup');
    p.textContent = text + extra;
    p.style.color = color;
    p.classList.remove('show'); void p.offsetWidth; p.classList.add('show');
  }

  // Floating flags behind everything.
  function sky() {
    const box = $('sky');
    const picks = shuffle(FLAGS).slice(0, 14);
    picks.forEach((f, i) => {
      const img = document.createElement('img');
      img.src = `img/${f.c}.svg`; img.alt = '';
      img.style.left = (i * 7.3 % 100) + '%';
      img.style.animationDuration = (14 + (i * 37) % 12) + 's';
      img.style.animationDelay = (-i * 2.1) + 's';
      img.style.width = (44 + (i * 13) % 40) + 'px';
      box.appendChild(img);
    });
  }

  // Pausing (app sent to the background or screen off): the clock stops too.
  function pause() {
    Sound.pause();
    if (G && !G.locked && !G.paused) { G.paused = true; G.cur.used = (performance.now() - G.cur.start); cancelAnimationFrame(raf); }
  }
  function resume() {
    Sound.resume();
    if (G && G.paused) { G.paused = false; G.cur.start = performance.now() - G.cur.used; raf = requestAnimationFrame(loop); }
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resume()));
  window.appPause = pause;
  window.appResume = resume;
  // Android back button: game → menu, results → menu, menu → leave the app.
  window.appBack = () => {
    if (current === 'game') { quitToMenu(); return true; }
    if (current === 'results') { Sound.play('click'); buildMenu(); show('menu'); return true; }
    return false;
  };

  $('playBtn').onclick = () => { Sound.play('click'); startGame(); };
  $('againBtn').onclick = () => { Sound.play('click'); startGame(); };
  $('menuBtn').onclick = () => { Sound.play('click'); buildMenu(); show('menu'); };
  $('quitBtn').onclick = quitToMenu;

  sky();
  buildMenu();
})();
