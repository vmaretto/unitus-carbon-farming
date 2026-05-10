# Realtime IT ↔ EN Translator

Two ways to drive the same pipeline (Italian ⇄ English simultaneous
translation, language auto-detected on every turn) over the OpenAI Realtime
API:

- **Web UI** (`server.py` + `index.html`) — single tap in the browser,
  WebRTC straight to OpenAI. Good for phones and laptops.
- **CLI** (`realtime_translate.py`) — Python WebSocket client with
  `sounddevice` audio I/O. Good for headless boxes or scripting.

## Web UI (tap-to-talk)

```bash
cd tools/realtime-translate
python -m venv .venv && source .venv/bin/activate     # optional
export OPENAI_API_KEY=sk-...
python server.py
```

Open <http://127.0.0.1:8787/> and tap the button. The tiny Python server
only mints ephemeral session tokens via `POST /v1/realtime/sessions`; the
audio itself flows directly between the browser and `api.openai.com` over
WebRTC, so the API key never reaches the page.

States of the button: blue = idle, orange = connecting, pulsing red = live.
Tap again to stop. Browsers require either `localhost` or HTTPS for
`getUserMedia`, so test from `127.0.0.1`/`localhost` (not the LAN IP).

## CLI

### Install

```bash
cd tools/realtime-translate
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

`sounddevice` depends on PortAudio (`brew install portaudio` on macOS,
`sudo apt install libportaudio2` on Debian/Ubuntu).

### Run

```bash
export OPENAI_API_KEY=sk-...
python realtime_translate.py
```

Speak in Italian or English; the translated audio starts playing as soon as
you pause. Use **headphones** so the loudspeaker output does not feed back
into the microphone (server VAD would otherwise interrupt the model with its
own voice).

## Pipeline

- 24 kHz mono PCM16 in both directions (the format the Realtime API expects).
- Microphone is captured in 30 ms blocks and streamed via
  `input_audio_buffer.append`.
- Server-side VAD with `silence_duration_ms = 350` commits a turn quickly and
  triggers `response.create` automatically, so the translation begins playing
  while the user is still in the next sentence.
- Output `response.audio.delta` chunks are written into a thread-safe ring
  buffer that feeds a `sounddevice` output stream — no extra encoding step
  on the playback path.
- On `input_audio_buffer.speech_started` (barge-in) the playback ring is
  flushed to avoid overlap with the previous translation.
