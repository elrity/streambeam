// World Flags sound: background music and sound effects, all made live with Web Audio (no sound files).
(function () {
  let ctx = null, musicBus, sfxBus, noiseBuf;
  let musicOn = true, sfxOn = true;
  let playing = null;          // current song mode: 'menu' | 'game' | null
  let timer = null, step = 0, nextTime = 0;

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const master = ctx.createDynamicsCompressor();
    master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = musicOn ? 0.32 : 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = sfxOn ? 0.7 : 0; sfxBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  const hz = m => 440 * Math.pow(2, (m - 69) / 12);

  function tone(bus, type, freq, t, dur, vol, opts = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    if (opts.detune) o.detune.value = opts.detune;
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = g;
    if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lp; g.connect(f); out = f; }
    o.connect(g); out.connect(bus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(bus, t, dur, vol, type, freq, freqTo) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = type; f.frequency.setValueAtTime(freq, t);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
    f.Q.value = type === 'bandpass' ? 1.2 : 0.7;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  // ---------- Music: an 8-bar happy loop (C major), sixteenth-note sequencer ----------
  const _ = null;
  const MELODY = [
    [72,_,76,_,79,_,76,_,77,_,76,_,74,_,72,_],
    [74,_,71,_,67,_,71,_,74,_,76,_,74,_,_,_],
    [72,_,76,_,81,_,79,_,76,_,79,_,81,_,84,_],
    [81,_,79,_,77,_,76,_,74,_,_,_,72,_,_,_],
    [77,77,_,81,_,84,_,81,77,_,81,_,84,_,86,_],
    [86,_,84,_,83,_,79,_,83,_,86,_,91,_,_,_],
    [88,_,84,_,81,_,84,_,88,_,86,_,84,_,81,_],
    [83,_,79,_,74,_,79,_,83,_,86,_,_,_,_,_],
  ];
  const CHORDS = [[60,64,67],[59,62,67],[57,60,64],[57,60,65],[57,60,65],[59,62,67],[57,60,64],[59,62,67]];
  const BASS = [36, 43, 45, 41, 41, 43, 45, 43];

  function scheduleStep(s, t, mode) {
    const bar = Math.floor(s / 16) % 8, i = s % 16;
    const sixteenth = 60 / bpm(mode) / 4;
    const up = mode === 'game' ? 2 : 0;
    const m = MELODY[bar][i];
    if (m) tone(musicBus, 'square', hz(m + up), t, sixteenth * 1.8, 0.09, { lp: 3200 });
    const ch = CHORDS[bar];
    tone(musicBus, 'triangle', hz(ch[i % 3] + 12 + up), t, sixteenth * 0.9, 0.05);
    if (i % 4 === 0 || (mode === 'game' && i % 4 === 2)) {
      const r = BASS[bar] + up + (i % 8 === 4 ? 12 : 0);
      tone(musicBus, 'triangle', hz(r), t, sixteenth * 1.9, 0.28);
    }
    // Drums
    if (i === 0 || i === 8 || (mode === 'game' && i === 10)) tone(musicBus, 'sine', 150, t, 0.18, 0.55, { to: 40 });
    if (i === 4 || i === 12) noise(musicBus, t, 0.14, 0.22, 'highpass', 1500);
    if (i % 2 === 0) noise(musicBus, t, 0.04, i % 4 === 2 ? 0.09 : 0.05, 'highpass', 7000);
  }

  const bpm = mode => (mode === 'game' ? 138 : 118);

  function tick() {
    if (!ctx || !playing) return;
    const sixteenth = 60 / bpm(playing) / 4;
    while (nextTime < ctx.currentTime + 0.15) {
      scheduleStep(step, nextTime, playing);
      nextTime += sixteenth; step++;
    }
  }

  function music(mode) {
    init();
    if (!ctx || playing === mode) return;
    playing = mode; step = 0; nextTime = ctx.currentTime + 0.08;
    clearInterval(timer);
    timer = setInterval(tick, 40);
  }
  function stopMusic() { playing = null; clearInterval(timer); }

  // ---------- Sound effects ----------
  const fx = {
    click() { const t = ctx.currentTime; tone(sfxBus, 'square', 660, t, 0.07, 0.25, { to: 1320 }); },
    select(n) { const t = ctx.currentTime; tone(sfxBus, 'triangle', hz(67 + n * 2), t, 0.12, 0.4); tone(sfxBus, 'triangle', hz(74 + n * 2), t + 0.06, 0.14, 0.35); },
    slide() { const t = ctx.currentTime; tone(sfxBus, 'sine', 900, t, 0.08, 0.15, { to: 2000 }); },
    whoosh() { const t = ctx.currentTime; noise(sfxBus, t, 0.35, 0.6, 'bandpass', 500, 4000); },
    correct() {
      const t = ctx.currentTime;
      [76, 80, 83, 88].forEach((m, k) => tone(sfxBus, 'triangle', hz(m), t + k * 0.06, 0.22, 0.4));
      tone(sfxBus, 'sine', hz(100), t + 0.24, 0.25, 0.15);
      noise(sfxBus, t + 0.18, 0.25, 0.12, 'highpass', 9000);
    },
    combo(n) {
      const t = ctx.currentTime + 0.25;
      for (let k = 0; k < Math.min(n, 6); k++) tone(sfxBus, 'square', hz(84 + k * 2), t + k * 0.04, 0.08, 0.12, { lp: 5000 });
    },
    wrong() {
      const t = ctx.currentTime;
      tone(sfxBus, 'sawtooth', 300, t, 0.18, 0.3, { to: 140, lp: 1800 });
      tone(sfxBus, 'sawtooth', 200, t + 0.16, 0.32, 0.3, { to: 80, lp: 1400 });
    },
    timeout() {
      const t = ctx.currentTime;
      tone(sfxBus, 'square', 180, t, 0.5, 0.25, { lp: 900 });
      tone(sfxBus, 'square', 185, t, 0.5, 0.2, { lp: 900, detune: 30 });
    },
    tick(urgent) { const t = ctx.currentTime; tone(sfxBus, 'sine', urgent ? 1760 : 1200, t, 0.05, urgent ? 0.3 : 0.18); },
    start() {
      const t = ctx.currentTime;
      [60, 64, 67, 72].forEach((m, k) => tone(sfxBus, 'square', hz(m), t + k * 0.08, 0.15, 0.2, { lp: 4000 }));
    },
    end(good) {
      const t = ctx.currentTime;
      const notes = good ? [72, 76, 79, 84, 79, 84, 88] : [67, 64, 60, 55];
      notes.forEach((m, k) => tone(sfxBus, good ? 'square' : 'triangle', hz(m), t + k * 0.12, 0.3, 0.22, { lp: 4000 }));
      if (good) noise(sfxBus, t + notes.length * 0.12, 0.6, 0.15, 'highpass', 8000);
    },
  };

  window.Sound = {
    unlock: init,
    music, stopMusic,
    play(name, arg) { init(); if (ctx && sfxOn && fx[name]) fx[name](arg); },
    setMusic(on) { musicOn = on; if (musicBus) musicBus.gain.setTargetAtTime(on ? 0.32 : 0, ctx.currentTime, 0.05); },
    setSfx(on) { sfxOn = on; if (sfxBus) sfxBus.gain.value = on ? 0.7 : 0; },
    pause() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); nextTime = ctx ? Math.max(nextTime, ctx.currentTime + 0.05) : 0; },
  };
})();
