'use strict';

const obsidian = require('obsidian');
const TRIAL_URL = 'https://quickvoicenote.com/trial';
const {
  Plugin, PluginSettingTab, Setting, Modal, Notice, Platform,
  normalizePath, requestUrl, TFile, TFolder, setIcon,
} = obsidian;

const PROTOCOL_ACTION = 'voice-note';

// Ready-made looks for a voice memo entry. "custom" means the user edited
// the template by hand; whatever is in appendTemplate is used as-is.
const ENTRY_STYLES = {
  list: {
    label: 'List item (time, player, transcript nested)',
    template: '- {{time}} {{embed}} {{caption}}\n    - {{transcript}}',
  },
  callout: {
    label: 'Voice callout (red mic card)',
    template: '> [!voice] {{time}} {{caption}}\n> {{embed}}\n> {{transcript}}',
  },
  quote: {
    label: 'Quote block',
    template: '> **{{time}}** {{caption}}\n> {{embed}}\n>\n> {{transcript}}',
  },
  heading: {
    label: 'Heading per memo',
    template: '### {{time}} {{caption}}\n{{embed}}\n\n{{transcript}}',
  },
  paragraph: {
    label: 'Plain paragraph',
    template: '**{{time}}** {{caption}}\n{{embed}}\n{{transcript}}',
  },
  minimal: {
    label: 'One line (time and transcript only)',
    template: '- {{time}} {{transcript}} {{link}}',
  },
};

// '#rgb' / '#rrggbb' → 'r, g, b' for use inside rgba(). Bad input → red.
function hexToRgbTriplet(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '239, 68, 68';
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
}

function styleForTemplate(tpl) {
  for (const k of Object.keys(ENTRY_STYLES)) {
    if (ENTRY_STYLES[k].template === tpl) return k;
  }
  return 'custom';
}

const DEFAULTS = {
  // What gets appended to the note. Empty placeholders collapse.
  textTemplate: '- {{time}} {{text}}',
  appendTemplate: ENTRY_STYLES.list.template,
  entryStyle: 'list',
  heading: '',
  timeFormat: 'HH:mm',
  // Where the entry lands: today's daily note, the note you are in, or
  // ask after each recording.
  destination: 'daily', // daily | current | ask
  currentNotePlacement: 'cursor', // cursor | end
  // How the audio file shows up in the note. The file is always kept in
  // the recordings folder.
  audioInNote: 'embed', // embed | link | none
  // Voice callout look: tint colour and how strong the background wash is.
  calloutColor: '#ef4444',
  calloutWash: 0.12, // 0–1
  // Safety net: recordings stop and save themselves at this length so a
  // forgotten phone in a pocket can't run for hours (and can't rack up
  // transcription cost). 0 disables.
  maxRecordingMinutes: 30,
  // Flow
  openNoteAfterSave: false,
  askForCaption: false,
  autoStartFromUri: true,
  showMobileButton: true,
  // Where recordings go and how they are named (moment.js format).
  recordingsFolder: 'Recordings',
  fileNameFormat: '[Voice] YYYY-MM-DD HH-mm-ss',
  // Daily note location
  useDailyNotesSettings: true,
  fallbackFolder: '',
  fallbackFormat: 'YYYY-MM-DD',
  fallbackTemplate: '',
  // Transcription. A license key routes through the Quick Voice Cloud
  // proxy (no other setup); otherwise bring your own OpenAI-compatible
  // /audio/transcriptions endpoint + API key.
  transcribe: false,
  licenseKey: '',
  cloudEndpoint: 'https://api.quickvoicenote.com/v1/audio/transcriptions',
  transcriptionEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
  transcriptionApiKey: '',
  transcriptionModel: 'whisper-1',
  transcriptionLanguage: '',
  transcriptionPrompt: '',
};

/* ------------------------------------------------------------------ *
 * Pure helpers (exposed to the offline test harness)
 * ------------------------------------------------------------------ */

const MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return '';
  for (const m of MIME_CANDIDATES) {
    try { if (isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
  }
  return '';
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function joinPath(folder, name) {
  const f = String(folder || '').replace(/^\/+|\/+$/g, '');
  return normalizePath(f ? f + '/' + name : name);
}

// Replace {{name}} placeholders. Lines that end up as nothing but
// whitespace, a bare list marker, a bare blockquote ">" or an empty heading
// are dropped, so optional placeholders (caption, transcript, embed)
// collapse cleanly when empty. A lone ">" that the template itself put
// between two non-empty quote lines is kept as a paragraph break.
function renderTemplate(tpl, vars) {
  const rendered = [];
  for (const rawLine of String(tpl || '').split('\n')) {
    const line = rawLine.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) =>
      vars[k] == null ? '' : String(vars[k]));
    // Trim the end and squash the gap an empty placeholder leaves mid-line
    // (leading indentation is left alone).
    const trimmed = line.replace(/\s+$/, '').replace(/(\S) {2,}/g, '$1 ');
    const hadPlaceholder = /\{\{/.test(rawLine);
    const empty = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)]|#{1,6})?\s*$/.test(trimmed);
    // Drop lines whose placeholders all came back empty. Keep spacer lines
    // the template wrote deliberately (no placeholder) for now; trimmed below.
    if (empty && hadPlaceholder) continue;
    rendered.push({ text: trimmed, empty });
  }
  // Remove spacer lines at the edges and collapse runs of spacers.
  const out = [];
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    if (r.empty) {
      const prev = out.length ? out[out.length - 1] : null;
      const next = rendered.slice(i + 1).find((x) => !x.empty);
      if (!prev || !next || prev.empty) continue;
    }
    out.push(r);
  }
  return out.map((r) => r.text).join('\n');
}

function headingLevel(line) {
  const m = /^(#{1,6})\s+\S/.exec(line);
  return m ? m[1].length : 0;
}

function normalizeHeading(h) {
  return String(h || '').trim().replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '').trim();
}

// Append `text` to `content`, optionally at the end of a heading's section.
function appendToNote(content, text, heading) {
  const target = normalizeHeading(heading);
  const body = String(content || '');
  if (!target) {
    const base = body.replace(/\s+$/, '');
    return base ? base + '\n' + text + '\n' : text + '\n';
  }
  const lines = body.split('\n');
  let hIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingLevel(lines[i]) && normalizeHeading(lines[i]) === target) { hIdx = i; break; }
  }
  if (hIdx < 0) {
    const base = body.replace(/\s+$/, '');
    const h = /^#/.test(String(heading).trim()) ? String(heading).trim() : '## ' + target;
    return (base ? base + '\n\n' : '') + h + '\n' + text + '\n';
  }
  const level = headingLevel(lines[hIdx]);
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    const l = headingLevel(lines[i]);
    if (l && l <= level) { end = i; break; }
  }
  let last = hIdx;
  for (let i = end - 1; i > hIdx; i--) {
    if (lines[i].trim() !== '') { last = i; break; }
  }
  const insertAt = last + 1;
  const newLines = text.split('\n');
  // Keep one blank line between the inserted text and a following heading.
  const tail = lines.slice(insertAt);
  while (tail.length && tail[0].trim() === '' && end !== lines.length) tail.shift();
  const rest = end === lines.length ? [] : [''].concat(tail);
  const result = lines.slice(0, insertAt).concat(newLines, rest).join('\n');
  return result.endsWith('\n') ? result : result + '\n';
}

// Minimal daily-note template support: {{date}}, {{time}}, {{title}},
// {{date:FORMAT}}, {{time:FORMAT}}.
function applyNoteTemplate(tpl, now, title) {
  return String(tpl || '').replace(/\{\{\s*(date|time|title)\s*(?::([^}]+))?\s*\}\}/g, (_, k, fmt) => {
    if (k === 'title') return title;
    if (k === 'date') return now.format(fmt || 'YYYY-MM-DD');
    return now.format(fmt || 'HH:mm');
  });
}

function uniquePath(exists, folder, base, ext) {
  let p = joinPath(folder, base + '.' + ext);
  let n = 1;
  while (exists(p)) p = joinPath(folder, base + ' ' + (++n) + '.' + ext);
  return p;
}

// Build a multipart/form-data body as an ArrayBuffer so it can go through
// Obsidian's requestUrl (which sidesteps CORS on mobile).
function buildMultipart(fields, file) {
  const boundary = '----ObsidianQuickVoiceNote' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    parts.push(enc.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
  }
  parts.push(enc.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="' + file.field +
    '"; filename="' + file.name.replace(/"/g, '') + '"\r\nContent-Type: ' + file.type + '\r\n\r\n'));
  parts.push(new Uint8Array(file.data));
  parts.push(enc.encode('\r\n--' + boundary + '--\r\n'));
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.byteLength; }
  return { body: body.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

function launcherUrls() {
  return {
    record: 'obsidian://' + PROTOCOL_ACTION + '?action=record',
    text: 'obsidian://' + PROTOCOL_ACTION + '?text=',
  };
}

/* ------------------------------------------------------------------ *
 * Recorder (MediaRecorder + a light level meter)
 * ------------------------------------------------------------------ */

class Recorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = '';
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not available in this environment.');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not supported here.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMimeType(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported.bind(MediaRecorder));
    this.rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.mimeType = this.rec.mimeType || mime || '';
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = Date.now();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        src.connect(this.analyser);
        this.buf = new Uint8Array(this.analyser.fftSize);
      }
    } catch (e) { /* meter is cosmetic */ }
  }

  get elapsedMs() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = (this.buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / this.buf.length);
    return Math.min(1, rms * 3);
  }

  stop() {
    return new Promise((resolve) => {
      const rec = this.rec;
      const finish = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType || (rec && rec.mimeType) || 'audio/webm' });
        const duration = this.elapsedMs;
        this.cleanup();
        resolve({ blob, duration, mimeType: blob.type });
      };
      if (!rec || rec.state === 'inactive') { finish(); return; }
      rec.onstop = finish;
      try { rec.stop(); } catch (e) { finish(); }
    });
  }

  cleanup() {
    try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (this.ctx) this.ctx.close(); } catch (e) { /* ignore */ }
    this.stream = null; this.rec = null; this.ctx = null; this.analyser = null; this.startedAt = 0;
  }

  discard() {
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; this.rec.stop(); } } catch (e) { /* ignore */ }
    this.chunks = [];
    this.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * Recording modal (long-form field notes: audio saved, transcript optional)
 * ------------------------------------------------------------------ */

class RecordModal extends Modal {
  constructor(plugin, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts || {};
    this.recorder = new Recorder();
    this.state = 'idle'; // idle | recording | review | saving
    this.result = null;
    // Where "current note" points, captured before the modal takes focus.
    this.target = plugin.captureTarget();
    this.dest = null; // chosen at save time when destination is "ask"
    this.timer = null;
    this.raf = null;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('qvn-modal');
    contentEl.empty();
    contentEl.addClass('qvn');

    contentEl.createEl('h2', { text: 'Voice note', cls: 'qvn-title' });
    this.statusEl = contentEl.createDiv({ cls: 'qvn-status', text: 'Tap to start recording' });
    this.timerEl = contentEl.createDiv({ cls: 'qvn-timer', text: '0:00' });
    const meter = contentEl.createDiv({ cls: 'qvn-meter' });
    this.meterFill = meter.createDiv({ cls: 'qvn-meter-fill' });

    this.bigBtn = contentEl.createEl('button', { cls: 'qvn-big', attr: { 'aria-label': 'Record' } });
    setIcon(this.bigBtn, 'mic');
    this.bigBtn.addEventListener('click', () => this.onBigButton());

    this.reviewEl = contentEl.createDiv({ cls: 'qvn-review' });
    this.reviewEl.hide();
    this.captionEl = this.reviewEl.createEl('textarea', {
      cls: 'qvn-caption', attr: { placeholder: 'Optional caption…', rows: '2' },
    });
    const row = this.reviewEl.createDiv({ cls: 'qvn-row' });
    const p = this.plugin;
    if (this.mustAsk()) {
      // Two save buttons: the note you came from, or today's note.
      const curBtn = row.createEl('button', { cls: 'mod-cta', text: 'Save to ' + this.target.file.basename });
      curBtn.addEventListener('click', () => this.save('current'));
      const dailyBtn = row.createEl('button', { text: "Save to today's note" });
      dailyBtn.addEventListener('click', () => this.save('daily'));
    } else {
      const saveBtn = row.createEl('button', { cls: 'mod-cta', text: 'Save to ' + p.destinationLabel(null, this.target) });
      saveBtn.addEventListener('click', () => this.save());
    }
    const discardBtn = row.createEl('button', { text: 'Discard' });
    discardBtn.addEventListener('click', () => { this.result = null; this.close(); });

    this.hintEl = contentEl.createDiv({ cls: 'qvn-hint' });
    this.hintEl.setText(this.mustAsk()
      ? 'Stop, then pick where it goes.'
      : p.settings.askForCaption
        ? 'Stop, add a caption, save.'
        : 'Stop saves straight to ' + p.destinationLabel(null, this.target) + '.');

    if (this.opts.autoStart) this.startRecording();
  }

  async onBigButton() {
    if (this.state === 'idle') return this.startRecording();
    if (this.state === 'recording') return this.stopRecording();
  }

  async startRecording() {
    if (this.state !== 'idle') return;
    try {
      await this.recorder.start();
    } catch (e) {
      console.error('[quick-voice-note] mic error', e);
      this.statusEl.setText('Microphone unavailable: ' + (e && e.message ? e.message : e));
      this.statusEl.addClass('qvn-error');
      return;
    }
    this.state = 'recording';
    this.bigBtn.addClass('is-recording');
    this.bigBtn.setAttribute('aria-label', 'Stop');
    setIcon(this.bigBtn, 'square');
    this.statusEl.removeClass('qvn-error');
    this.statusEl.setText('Recording…');
    const limitMs = Math.max(0, Number(this.plugin.settings.maxRecordingMinutes) || 0) * 60 * 1000;
    this.timer = window.setInterval(() => {
      const ms = this.recorder.elapsedMs;
      this.timerEl.setText(formatDuration(ms));
      if (limitMs && ms >= limitMs && this.state === 'recording') {
        new Notice('Reached the ' + this.plugin.settings.maxRecordingMinutes + '-minute limit — saving.');
        this.stopRecording();
      } else if (limitMs && limitMs - ms <= 60 * 1000 && limitMs - ms > 59 * 1000) {
        this.statusEl.setText('One minute left');
      }
    }, 250);
    const tick = () => {
      if (this.state !== 'recording') return;
      this.meterFill.style.width = Math.round(this.recorder.level() * 100) + '%';
      this.raf = window.requestAnimationFrame(tick);
    };
    tick();
  }

  async stopRecording() {
    if (this.state !== 'recording') return;
    this.state = 'review';
    this.stopTimers();
    this.bigBtn.removeClass('is-recording');
    this.bigBtn.disabled = true;
    this.statusEl.setText('Finishing…');
    this.result = await this.recorder.stop();
    this.timerEl.setText(formatDuration(this.result.duration));
    this.meterFill.style.width = '0%';
    if (!this.result.blob || this.result.blob.size === 0) {
      this.statusEl.setText('Nothing was recorded.');
      this.state = 'idle';
      this.bigBtn.disabled = false;
      setIcon(this.bigBtn, 'mic');
      return;
    }
    if (this.plugin.settings.askForCaption || this.mustAsk()) {
      this.statusEl.setText('Recorded ' + formatDuration(this.result.duration));
      this.bigBtn.hide();
      this.reviewEl.show();
      if (this.plugin.settings.askForCaption) this.captionEl.focus();
      else this.captionEl.hide();
    } else {
      await this.save();
    }
  }

  // "Ask" only makes sense when there is a current note to offer.
  mustAsk() {
    return this.plugin.settings.destination === 'ask' && !!(this.target && this.target.file);
  }

  async save(dest) {
    if (!this.result || this.state === 'saving') return;
    this.state = 'saving';
    this.dest = dest || null;
    this.reviewEl.hide();
    this.bigBtn.hide();
    this.statusEl.setText('Saving…');
    try {
      await this.plugin.saveRecording(this.result, this.captionEl.value.trim(),
        (msg) => this.statusEl.setText(msg), this.dest, this.target);
      this.result = null;
      this.close();
    } catch (e) {
      console.error('[quick-voice-note] save failed', e);
      this.statusEl.setText('Save failed: ' + (e && e.message ? e.message : e));
      this.statusEl.addClass('qvn-error');
      this.state = 'review';
      this.reviewEl.show();
    }
  }

  stopTimers() {
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    if (this.raf) { window.cancelAnimationFrame(this.raf); this.raf = null; }
  }

  onClose() {
    this.stopTimers();
    if (this.state === 'recording') this.recorder.discard();
    this.recorder.cleanup();
    this.contentEl.empty();
    this.plugin.activeModal = null;
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

class QuickVoiceNotePlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved);
    // Installs from before the style picker: work out which preset (if
    // any) their hand-written template matches.
    if (!saved.entryStyle) this.settings.entryStyle = styleForTemplate(this.settings.appendTemplate);
    // Pre-launch builds saved a placeholder cloud endpoint; move them to the real one.
    if (/quick-voice-cloud\.workers\.dev/.test(this.settings.cloudEndpoint || '')) this.settings.cloudEndpoint = DEFAULTS.cloudEndpoint;
    this.activeModal = null;
    this.applyCalloutStyle();
    this.register(() => {
      document.body.style.removeProperty('--qvn-callout-rgb');
      document.body.style.removeProperty('--qvn-callout-wash');
    });

    this.addRibbonIcon('mic', 'Record voice note', () => this.openRecorder({ autoStart: false }));

    // On mobile the ribbon lives in a drawer; give recording an obvious
    // one-tap home: a mic button in the note's header actions, sitting
    // next to the reading-mode toggle. Registered as a real view action so
    // Obsidian lays it out (and never covers the "more options" menu).
    if (Platform.isMobile && this.settings.showMobileButton) {
      const attach = () => {
        this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
          const view = leaf.view;
          if (!(view instanceof obsidian.MarkdownView)) return;
          if (view.containerEl.querySelector('.qvn-action')) return;
          const el = view.addAction('mic', 'Record voice note', () => this.openRecorder({ autoStart: true }));
          el.addClass('qvn-action');
        });
      };
      this.registerEvent(this.app.workspace.on('active-leaf-change', attach));
      this.registerEvent(this.app.workspace.on('layout-change', attach));
      this.app.workspace.onLayoutReady(attach);
      this.register(() => document.querySelectorAll('.qvn-action').forEach((el) => el.remove()));
    }

    this.addCommand({
      id: 'record',
      name: 'Record voice note',
      callback: () => this.openRecorder({ autoStart: false }),
    });
    this.addCommand({
      id: 'record-now',
      name: 'Start recording immediately',
      callback: () => this.openRecorder({ autoStart: true }),
    });
    this.addCommand({
      id: 'open-daily-note',
      name: "Open today's daily note",
      callback: async () => {
        const f = await this.getOrCreateDailyNote();
        await this.app.workspace.getLeaf(false).openFile(f);
      },
    });
    this.addCommand({
      id: 'copy-launcher-url',
      name: 'Copy launcher URL (for iOS Shortcuts / Android shortcuts)',
      callback: async () => {
        await navigator.clipboard.writeText(launcherUrls().record);
        new Notice('Copied ' + launcherUrls().record);
      },
    });

    // obsidian://voice-note?text=...  -> append text straight to today's note
    // obsidian://voice-note           -> open recorder (auto-start per setting)
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, async (params) => {
      try {
        if (params.text != null && String(params.text).trim() !== '') {
          const file = await this.appendText(String(params.text));
          if (params.open === '1' || params.open === 'true') {
            await this.app.workspace.getLeaf(false).openFile(file);
          }
          return;
        }
        const auto = params.autostart != null
          ? (params.autostart === '1' || params.autostart === 'true')
          : this.settings.autoStartFromUri;
        this.openRecorder({ autoStart: auto });
      } catch (e) {
        console.error('[quick-voice-note] protocol handler', e);
        new Notice('Quick Voice Note: ' + (e && e.message ? e.message : e));
      }
    });

    this.addSettingTab(new QuickVoiceNoteSettingTab(this.app, this));
  }

  onunload() {
    if (this.activeModal) this.activeModal.close();
  }

  async saveSettings() { await this.saveData(this.settings); }

  // Push the chosen callout colour/wash into CSS variables on <body> so
  // styles.css can use them and no theme rule can out-rank them.
  applyCalloutStyle() {
    const s = this.settings;
    const wash = Math.min(1, Math.max(0, Number(s.calloutWash)));
    document.body.style.setProperty('--qvn-callout-rgb', hexToRgbTriplet(s.calloutColor));
    document.body.style.setProperty('--qvn-callout-wash', String(isNaN(wash) ? 0.12 : wash));
  }

  openRecorder(opts) {
    if (this.activeModal) {
      // Second launch while open: treat as "stop" if recording, else focus.
      if (this.activeModal.state === 'recording') this.activeModal.stopRecording();
      return this.activeModal;
    }
    this.activeModal = new RecordModal(this, opts);
    this.activeModal.open();
    return this.activeModal;
  }

  now() { return obsidian.moment(); }

  /* ---- Daily note ---- */

  getDailyNoteConfig() {
    const s = this.settings;
    if (s.useDailyNotesSettings) {
      try {
        const dn = this.app.internalPlugins && this.app.internalPlugins.getPluginById('daily-notes');
        if (dn && dn.enabled) {
          const o = (dn.instance && dn.instance.options) || {};
          return { folder: o.folder || '', format: o.format || 'YYYY-MM-DD', template: o.template || '' };
        }
      } catch (e) { /* fall through */ }
      try {
        const pn = this.app.plugins && this.app.plugins.getPlugin('periodic-notes');
        const d = pn && pn.settings && pn.settings.daily;
        if (d && d.enabled) {
          return { folder: d.folder || '', format: d.format || 'YYYY-MM-DD', template: d.template || '' };
        }
      } catch (e) { /* fall through */ }
    }
    return { folder: s.fallbackFolder || '', format: s.fallbackFormat || 'YYYY-MM-DD', template: s.fallbackTemplate || '' };
  }

  async ensureFolder(folder) {
    const f = String(folder || '').replace(/^\/+|\/+$/g, '');
    if (!f) return;
    const parts = f.split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p;
      const existing = this.app.vault.getAbstractFileByPath(normalizePath(cur));
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error('"' + cur + '" exists but is not a folder');
      await this.app.vault.createFolder(normalizePath(cur));
    }
  }

  async getOrCreateDailyNote() {
    const cfg = this.getDailyNoteConfig();
    const now = this.now();
    const title = now.format(cfg.format);
    const path = joinPath(cfg.folder, title + '.md');
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    if (existing) throw new Error('"' + path + '" exists but is not a file');
    await this.ensureFolder(cfg.folder);
    let content = '';
    if (cfg.template) {
      let tp = normalizePath(cfg.template);
      if (!/\.md$/i.test(tp)) tp += '.md';
      const tf = this.app.vault.getAbstractFileByPath(tp);
      if (tf instanceof TFile) content = applyNoteTemplate(await this.app.vault.read(tf), now, title);
    }
    return this.app.vault.create(path, content);
  }

  async appendToDailyNote(text) {
    const file = await this.getOrCreateDailyNote();
    const heading = this.settings.heading;
    if (typeof this.app.vault.process === 'function') {
      await this.app.vault.process(file, (data) => appendToNote(data, text, heading));
    } else {
      const data = await this.app.vault.read(file);
      await this.app.vault.modify(file, appendToNote(data, text, heading));
    }
    return file;
  }

  /* ---- Destination (daily note vs. the note you are in) ---- */

  // Snapshot the note the user is looking at, plus the live editor and
  // cursor if it's in edit mode. Taken before the recorder opens so the
  // modal can't disturb it.
  captureTarget() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.file) return null;
    const editor = view.getMode && view.getMode() === 'source' ? view.editor : null;
    return { file: view.file, editor, cursor: editor ? editor.getCursor() : null };
  }

  // 'current' only when there actually is a current note; otherwise the
  // daily note is the safe landing spot.
  resolveDestination(dest, target) {
    const d = dest || this.settings.destination || 'daily';
    if (d === 'daily') return 'daily';
    return target && target.file ? 'current' : 'daily';
  }

  destinationLabel(dest, target) {
    return this.resolveDestination(dest, target) === 'current'
      ? (target.file.basename || 'current note')
      : "today's note";
  }

  async insertEntry(text, dest, target) {
    if (this.resolveDestination(dest, target) === 'daily') return this.appendToDailyNote(text);
    const { file, editor, cursor } = target;
    if (editor && cursor && this.settings.currentNotePlacement === 'cursor') {
      // Drop the entry on its own line(s) right after the cursor's line.
      const line = cursor.line;
      const lineText = editor.getLine(line) || '';
      const insert = (lineText.trim() ? '\n' : '') + text + '\n';
      editor.replaceRange(insert, { line, ch: lineText.length });
      const added = insert.split('\n').length - 1;
      editor.setCursor({ line: line + added, ch: 0 });
      return file;
    }
    const heading = this.settings.heading;
    if (typeof this.app.vault.process === 'function') {
      await this.app.vault.process(file, (data) => appendToNote(data, text, heading));
    } else {
      const data = await this.app.vault.read(file);
      await this.app.vault.modify(file, appendToNote(data, text, heading));
    }
    return file;
  }

  async appendText(text) {
    const now = this.now();
    const line = renderTemplate(this.settings.textTemplate, {
      time: now.format(this.settings.timeFormat),
      date: now.format('YYYY-MM-DD'),
      text: text.trim(),
    });
    // URL text can't ask, so "ask" behaves like "current note" here.
    const file = await this.insertEntry(line, null, this.captureTarget());
    new Notice('Added to ' + file.basename);
    return file;
  }

  /* ---- Recording ---- */

  async saveRecording(result, caption, progress, dest, target) {
    const report = progress || (() => {});
    const s = this.settings;
    const now = this.now();
    const ext = extForMime(result.mimeType);
    const base = now.format(s.fileNameFormat || DEFAULTS.fileNameFormat).replace(/[\\/:*?"<>|]/g, '-');
    await this.ensureFolder(s.recordingsFolder);
    const path = uniquePath((p) => !!this.app.vault.getAbstractFileByPath(p), s.recordingsFolder, base, ext);
    const data = await result.blob.arrayBuffer();
    report('Saving audio…');
    const audioFile = await this.app.vault.createBinary(path, data);

    let transcript = '';
    if (s.transcribe) {
      report('Transcribing…');
      try {
        transcript = await this.transcribe(data, audioFile.name, result.mimeType);
      } catch (e) {
        console.error('[quick-voice-note] transcription failed', e);
        new Notice('Transcription failed: ' + (e && e.message ? e.message : e));
      }
    }

    report('Adding to ' + this.destinationLabel(dest, target) + '…');
    // The audio file is always kept; this only decides how the note refers
    // to it. {{embed}} downgrades to a link, or to nothing, so the same
    // template works for every choice.
    const embed = '![[' + audioFile.path + ']]';
    const link = '[[' + audioFile.path + ']]';
    const audio = s.audioInNote || 'embed';
    const line = renderTemplate(s.appendTemplate, {
      time: now.format(s.timeFormat),
      date: now.format('YYYY-MM-DD'),
      file: audioFile.path,
      name: audioFile.name,
      embed: audio === 'embed' ? embed : audio === 'link' ? link : '',
      link: audio === 'none' ? '' : link,
      caption: caption || '',
      transcript: transcript.replace(/\s+/g, ' ').trim(),
      duration: formatDuration(result.duration),
    });
    const note = await this.insertEntry(line, dest, target);
    new Notice('Voice note saved to ' + note.basename);
    if (s.openNoteAfterSave) {
      await this.app.workspace.getLeaf(false).openFile(note);
    }
    return { audioFile, note, transcript };
  }

  async transcribe(data, fileName, mimeType) {
    const s = this.settings;
    // A license key wins: route through the cloud proxy with zero other setup.
    const useCloud = !!(s.licenseKey && s.licenseKey.trim());
    const endpoint = useCloud ? (s.cloudEndpoint || DEFAULTS.cloudEndpoint) : s.transcriptionEndpoint;
    const apiKey = useCloud ? s.licenseKey.trim() : s.transcriptionApiKey;
    if (!endpoint) throw new Error('No transcription endpoint configured');
    const { body, contentType } = buildMultipart({
      model: useCloud ? 'whisper-large-v3-turbo' : (s.transcriptionModel || 'whisper-1'),
      language: s.transcriptionLanguage || '',
      prompt: s.transcriptionPrompt || '',
      response_format: 'json',
    }, { field: 'file', name: fileName, type: mimeType || 'application/octet-stream', data });
    const headers = { 'Content-Type': contentType };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const resp = await requestUrl({ url: endpoint, method: 'POST', headers, body, throw: false });
    if (resp.status < 200 || resp.status >= 300) {
      let msg = 'HTTP ' + resp.status;
      try { msg += ': ' + (resp.json && resp.json.error && resp.json.error.message || resp.text.slice(0, 200)); } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const json = resp.json || JSON.parse(resp.text);
    return String(json.text || '');
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

class QuickVoiceNoteSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    const text = (el, name, desc, key, placeholder) => new Setting(el).setName(name).setDesc(desc)
      .addText((t) => t.setPlaceholder(placeholder || '').setValue(s[key]).onChange(async (v) => { s[key] = v; await p.saveSettings(); }));
    const toggle = (el, name, desc, key) => new Setting(el).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(!!s[key]).onChange(async (v) => { s[key] = v; await p.saveSettings(); }));
    const area = (el, name, desc, key, onSet) => new Setting(el).setName(name).setDesc(desc).setClass('qvn-setting-area')
      .addTextArea((t) => { t.setValue(s[key]).onChange(async (v) => { s[key] = v; if (onSet) onSet(v); await p.saveSettings(); }); t.inputEl.rows = 3; });
    const dropdown = (el, name, desc, key, options, onSet) => new Setting(el).setName(name).setDesc(desc)
      .addDropdown((d) => { d.addOptions(options).setValue(s[key]).onChange(async (v) => { s[key] = v; if (onSet) onSet(v); await p.saveSettings(); }); });

    /* Essentials */
    const info = containerEl.createDiv({ cls: 'qvn-info' });
    info.createEl('p', { text: 'Tap the mic (ribbon, or the red mic in the note header on mobile), speak as long as you like, tap stop. The audio is saved to your vault and — with transcription on — added to your note as readable text. Defaults cover the rest; tweak them under Advanced if you ever need to.' });

    toggle(containerEl, 'Transcribe recordings', 'Long recordings become readable text in the note.', 'transcribe');

    /* Transcription: cloud key or bring your own */
    new Setting(containerEl).setName('Transcription').setHeading();
    let advanced = null; // the Advanced <details>, assigned below
    const plan = containerEl.createDiv({ cls: 'qvn-plan' });
    plan.createDiv({ cls: 'qvn-plan-title', text: 'Cloud key' });
    plan.createDiv({ cls: 'qvn-plan-price', text: 'A$9 / month · 3-day free trial · cancel anytime' });
    plan.createEl('p', { text: 'No API accounts, nothing to configure. Start a trial, paste the license key from your email below, and transcription just works. Cancel anytime from the link in your receipt email.' });
    const actions = plan.createDiv({ cls: 'qvn-plan-actions' });
    new obsidian.ButtonComponent(actions).setButtonText('Start free trial').setCta().onClick(() => window.open(TRIAL_URL));
    actions.createEl('a', { text: 'Manage or cancel subscription', href: 'https://app.lemonsqueezy.com/my-orders' });
    const byo = actions.createEl('a', { text: 'Or bring your own API key', href: '#' });
    byo.addEventListener('click', (e) => { e.preventDefault(); if (advanced) { advanced.open = true; advanced.scrollIntoView({ behavior: 'smooth' }); } });
    const statusEl = plan.createDiv({ cls: 'qvn-plan-status' });
    const refreshStatus = () => {
      statusEl.className = 'qvn-plan-status';
      if (s.licenseKey && s.licenseKey.trim()) { statusEl.addClass('is-ok'); statusEl.setText('Cloud key set — recordings are transcribed through Quick Voice Note Cloud.'); }
      else if (s.transcriptionApiKey && s.transcriptionApiKey.trim()) { statusEl.addClass('is-ok'); statusEl.setText('Using your own API key (see Advanced → Transcription service).'); }
      else { statusEl.addClass('is-warn'); statusEl.setText('No key yet — recordings are saved but not transcribed. Start a trial or add your own key.'); }
    };
    this.refreshStatus = refreshStatus;
    refreshStatus();
    new Setting(containerEl).setName('License key').setDesc('From your Quick Voice Note Cloud welcome email. Leave blank if you use your own API key.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX'); t.setValue(s.licenseKey).onChange(async (v) => { s.licenseKey = v.trim(); await p.saveSettings(); refreshStatus(); }); });

    /* Where and how it lands */
    new Setting(containerEl).setName('In the note').setHeading();
    dropdown(containerEl, 'Save to', 'Where each voice memo goes. "Ask" offers both after you stop. Falls back to the daily note when no note is open.', 'destination', {
      daily: "Today's daily note",
      current: 'The note I\'m in',
      ask: 'Ask after each recording',
    }, () => this.display());
    if (s.destination !== 'daily') {
      dropdown(containerEl, 'In the current note, put it', 'At the cursor needs the note in edit mode; otherwise it goes to the end (under the heading below, if set).', 'currentNotePlacement', {
        cursor: 'At the cursor',
        end: 'At the end of the note',
      });
    }
    dropdown(containerEl, 'Audio in the note', 'The recording is always kept in the recordings folder. This is only how the note refers to it.', 'audioInNote', {
      embed: 'Embedded player',
      link: 'Link to the file',
      none: 'Not mentioned (transcript only)',
    });
    const styleOptions = {};
    for (const k of Object.keys(ENTRY_STYLES)) styleOptions[k] = ENTRY_STYLES[k].label;
    styleOptions.custom = 'Custom (edit the template under Advanced)';
    dropdown(containerEl, 'Memo style', 'How each entry is written. Pick one, or edit the recording template under Advanced for your own.', 'entryStyle', styleOptions, (v) => {
      if (ENTRY_STYLES[v]) s.appendTemplate = ENTRY_STYLES[v].template;
      this.display();
    });
    if (s.entryStyle === 'callout' || /\[!voice\]/i.test(s.appendTemplate)) {
      const colorSetting = new Setting(containerEl).setName('Card colour').setDesc('Tint for the voice callout: icon, edge and background wash.');
      if (typeof colorSetting.addColorPicker === 'function') {
        colorSetting.addColorPicker((c) => c.setValue(s.calloutColor).onChange(async (v) => {
          s.calloutColor = v; p.applyCalloutStyle(); await p.saveSettings();
        }));
      } else {
        colorSetting.addText((t) => t.setPlaceholder('#ef4444').setValue(s.calloutColor).onChange(async (v) => {
          s.calloutColor = v.trim(); p.applyCalloutStyle(); await p.saveSettings();
        }));
      }
      new Setting(containerEl).setName('Wash strength').setDesc('How strongly the card background is tinted.')
        .addSlider((sl) => sl.setLimits(0, 60, 2).setValue(Math.round(Number(s.calloutWash) * 100)).setDynamicTooltip()
          .onChange(async (v) => { s.calloutWash = v / 100; p.applyCalloutStyle(); await p.saveSettings(); }));
    }

    // Live preview of the chosen style, rendered like it will be in a note.
    const preview = containerEl.createDiv({ cls: 'qvn-preview' });
    preview.createDiv({ cls: 'qvn-preview-label', text: 'Preview' });
    const previewBody = preview.createDiv({ cls: 'qvn-preview-body markdown-rendered' });
    const sample = renderTemplate(s.appendTemplate, {
      time: '09:41', date: '2026-01-01', file: 'Recordings/Voice.m4a', name: 'Voice.m4a',
      // A real embed needs a real file; stand in with a marker.
      embed: s.audioInNote === 'embed' ? '`▶ 0:07 ────────`' : s.audioInNote === 'link' ? '[[Recordings/Voice.m4a]]' : '',
      link: s.audioInNote === 'none' ? '' : '[[Recordings/Voice.m4a]]',
      caption: 'Block 7', transcript: 'Nothing to pick in block seven, skip it this week.', duration: '0:07',
    });
    const MR = obsidian.MarkdownRenderer;
    try {
      const r = MR && (MR.render ? MR.render(this.app, sample, previewBody, '', p) : MR.renderMarkdown(sample, previewBody, '', p));
      if (r && r.catch) r.catch(() => previewBody.setText(sample));
    } catch (e) {
      previewBody.setText(sample);
    }

    /* Phone shortcuts */
    new Setting(containerEl).setName('Phone shortcut').setHeading();
    const info2 = containerEl.createDiv({ cls: 'qvn-info' });
    info2.createEl('p', { text: 'Point a one-tap shortcut (Action Button, Control Center, home screen, NFC tag) at this URL: Obsidian opens, recording starts immediately, one tap stops and saves.' });
    const urls = launcherUrls();
    new Setting(containerEl).setName('Record URL').setDesc(urls.record)
      .addButton((b) => b.setButtonText('Copy').onClick(async () => { await navigator.clipboard.writeText(urls.record); new Notice('Copied'); }));

    /* Advanced — everything has a working default */
    const det = containerEl.createEl('details', { cls: 'qvn-advanced' });
    advanced = det;
    det.createEl('summary', { text: 'Advanced' });

    new Setting(det).setName('Behavior').setHeading();
    toggle(det, 'Open the note after saving', '', 'openNoteAfterSave');
    toggle(det, 'Ask for a caption before saving a recording', '', 'askForCaption');
    toggle(det, 'Auto-start recording when launched from a URL', 'Override per URL with autostart=1 or 0.', 'autoStartFromUri');
    new Setting(det).setName('Maximum recording length (minutes)').setDesc('Recording stops and saves itself at this length, so a forgotten phone can\'t run for hours. 0 = no limit.')
      .addText((t) => { t.inputEl.type = 'number'; t.inputEl.min = '0'; t.setValue(String(s.maxRecordingMinutes)).onChange(async (v) => {
        const n = Math.max(0, Math.floor(Number(v) || 0)); s.maxRecordingMinutes = n; await p.saveSettings();
      }); });
    toggle(det, 'Record button in note header on mobile', 'Takes effect after the plugin reloads.', 'showMobileButton');

    new Setting(det).setName('Files and formatting').setHeading();
    text(det, 'Recordings folder', '', 'recordingsFolder', 'Recordings');
    text(det, 'Recording file name', 'moment.js format; wrap literal text in [brackets].', 'fileNameFormat', DEFAULTS.fileNameFormat);
    text(det, 'Append under heading', 'E.g. "## Voice notes". Blank appends at the end of the note.', 'heading', '');
    text(det, 'Time format', 'moment.js format for {{time}}.', 'timeFormat', 'HH:mm');
    area(det, 'Text template', 'For text sent via the obsidian://voice-note?text= URL. Placeholders: {{time}} {{date}} {{text}}.', 'textTemplate');
    area(det, 'Recording template', 'Placeholders: {{time}} {{date}} {{embed}} {{link}} {{file}} {{name}} {{caption}} {{transcript}} {{duration}}. Empty lines collapse. Editing this switches Memo style to Custom.', 'appendTemplate',
      (v) => { s.entryStyle = styleForTemplate(v); });

    new Setting(det).setName('Daily note location').setHeading();
    toggle(det, 'Use the Daily Notes plugin settings', 'Turn off to set folder, format and template here.', 'useDailyNotesSettings');
    text(det, 'Fallback folder', '', 'fallbackFolder', '');
    text(det, 'Fallback date format', '', 'fallbackFormat', 'YYYY-MM-DD');
    text(det, 'Fallback template file', '', 'fallbackTemplate', 'Templates/Daily');

    new Setting(det).setName('Transcription service (bring your own)').setHeading();
    const info3 = det.createDiv({ cls: 'qvn-info' });
    info3.createEl('p', { text: 'Used only when no license key is set above. Point at any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a local Whisper server) with your own API key.' });
    new Setting(det).setName('API key').setDesc('Stored in this vault\'s plugin data.')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.transcriptionApiKey).onChange(async (v) => { s.transcriptionApiKey = v.trim(); await p.saveSettings(); if (this.refreshStatus) this.refreshStatus(); }); });
    text(det, 'Endpoint', '', 'transcriptionEndpoint', DEFAULTS.transcriptionEndpoint);
    text(det, 'Model', '', 'transcriptionModel', 'whisper-large-v3-turbo');
    text(det, 'Language', 'ISO code, e.g. en. Blank auto-detects.', 'transcriptionLanguage', '');
    text(det, 'Vocabulary hint', 'Optional prompt for names and jargon.', 'transcriptionPrompt', '');
    text(det, 'Cloud endpoint', 'Where the license key sends audio. Only change if self-hosting the proxy.', 'cloudEndpoint', DEFAULTS.cloudEndpoint);
  }
}

module.exports = QuickVoiceNotePlugin;

// Exposed for the offline test harness in tools/; unused by Obsidian.
module.exports.__test = {
  DEFAULTS, PROTOCOL_ACTION, MIME_CANDIDATES, ENTRY_STYLES, styleForTemplate, hexToRgbTriplet,
  pickMimeType, extForMime, formatDuration, joinPath, renderTemplate,
  appendToNote, applyNoteTemplate, uniquePath, buildMultipart, launcherUrls,
  normalizeHeading, headingLevel,
};
