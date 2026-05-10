# Realtime IT ↔ EN Translator

Standalone CLI that pipes the microphone into the OpenAI Realtime API and plays
back a simultaneous translation: Italian → English and English → Italian.
The model auto-detects the spoken language on every turn.

## Install

```bash
cd tools/realtime-translate
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

`sounddevice` depends on PortAudio (`brew install portaudio` on macOS,
`sudo apt install libportaudio2` on Debian/Ubuntu).

## Run

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
