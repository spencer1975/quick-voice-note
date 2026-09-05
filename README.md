<p align="center">
  <img src="assets/logo.png" width="160" alt="Quick Voice Note logo" />
</p>

<h1 align="center">Quick Voice Note</h1>

<p align="center"><strong>Press a button. Talk as long as you like. Read it in today's note.</strong></p>

Voice field notes for Obsidian. One tap starts a recording; stopping saves the
audio to your vault and appends a timestamped, transcribed entry to today's
daily note:

```markdown
- 14:32 ![[Recordings/Voice 2026-09-05 14-32-10.m4a]]
    - irrigation line three is leaking near the gate, needs a clamp before Monday
```

Built for people who capture thoughts away from a desk — farmers walking
paddocks, horticulturalists between rows, or anyone whose best ideas arrive
mid-stride. Unlike system dictation, it doesn't cut off when you pause, keeps
the original audio as backup, and files everything exactly where you'll look
for it tonight.

## How it works

- **Mobile:** a floating mic button sits on every note — tap it and you're
  already recording. It slips away while you scroll and comes right back.
- **Desktop:** mic button in the ribbon, or the "Record voice note" command.
- **One-tap from your pocket:** point an iOS Shortcut, Android shortcut, or an
  NFC tag at `obsidian://voice-note` — Obsidian opens with recording already
  running. One tap stops and saves.
- Stopping saves the audio into your vault (`Recordings/` by default),
  transcribes it, and appends the entry to today's daily note — respecting
  your Daily Notes folder, format, and template.

## Transcription

Recordings become readable text via any OpenAI-compatible transcription API.
Bring your own key (OpenAI, Groq, or a local Whisper server) under
**Settings → Advanced → Transcription service**.

Prefer zero setup? A license key (coming soon) enables managed transcription
with no accounts, no API keys, and no configuration — one key and it works.

Transcription is optional: without it you still get one-tap audio capture
filed into your daily notes.

## Install

Until the plugin is accepted into the community directory: copy `main.js`,
`manifest.json`, and `styles.css` into
`<your vault>/.obsidian/plugins/quick-voice-note/`, then enable **Quick Voice
Note** in Settings → Community plugins.

## Privacy

- Audio stays in your vault. It leaves your device only if transcription is
  enabled, and then only to the endpoint you configure.
- Your API key is stored in the plugin's local data file inside your vault and
  is never transmitted anywhere except the transcription endpoint you chose.

## Settings

The defaults are deliberately boring — most people only ever touch the
transcription key. Everything else (templates, folders, headings, file
naming, daily-note fallbacks) lives under **Advanced**.
