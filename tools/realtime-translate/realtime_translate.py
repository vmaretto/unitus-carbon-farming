"""
Bidirectional simultaneous translator (IT <-> EN) over the OpenAI Realtime API.

The script captures microphone audio, streams it to the Realtime API as PCM16
@ 24 kHz mono, and plays back the translated audio response as soon as deltas
arrive.  Language detection is delegated to the model: Italian input is
translated to English, English input is translated to Italian.

Run:
    export OPENAI_API_KEY=sk-...
    python realtime_translate.py

Use headphones to avoid the loudspeaker feeding back into the microphone
(the server-side VAD will otherwise treat the playback as user speech and
will keep interrupting itself).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
import sys
import threading
from typing import Optional

import numpy as np
import sounddevice as sd
import websockets
from websockets.client import WebSocketClientProtocol

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
SAMPLE_RATE = 24_000          # Realtime API expects 24 kHz PCM16 mono
CHANNELS = 1
DTYPE = "int16"
MIC_BLOCK_MS = 30             # 30 ms blocks -> ~720 samples, low latency
MIC_BLOCK_SAMPLES = SAMPLE_RATE * MIC_BLOCK_MS // 1000
PLAYBACK_BLOCK_SAMPLES = SAMPLE_RATE * 20 // 1000   # 20 ms playback chunks

VOICE = "alloy"

INSTRUCTIONS = (
    "You are a real-time simultaneous interpreter between Italian and English. "
    "Detect the language of the user's speech automatically: "
    "if the user speaks Italian, translate the meaning into fluent English; "
    "if the user speaks English, translate the meaning into fluent Italian. "
    "Output ONLY the translated sentence as natural spoken audio, with no "
    "preamble, no commentary, no language labels, no apologies. "
    "Keep the speaking pace close to the speaker's, start as soon as enough "
    "context is available, and never repeat or paraphrase yourself."
)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def b64_pcm16(samples: np.ndarray) -> str:
    return base64.b64encode(samples.tobytes()).decode("ascii")


def pcm16_from_b64(data: str) -> np.ndarray:
    raw = base64.b64decode(data)
    return np.frombuffer(raw, dtype=np.int16)


# ----------------------------------------------------------------------------
# Audio I/O
# ----------------------------------------------------------------------------
class MicCapture:
    """Pushes microphone PCM16 chunks into an asyncio.Queue."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
        self._stream: Optional[sd.InputStream] = None

    def _callback(self, indata, frames, time_info, status) -> None:
        if status:
            print(f"[mic] {status}", file=sys.stderr)
        # indata is a (frames, 1) int16 buffer; copy because sounddevice
        # reuses it after the callback returns.
        chunk = bytes(indata)
        try:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, chunk)
        except asyncio.QueueFull:
            # Drop the oldest block; falling behind on the network is worse
            # than losing 30 ms of microphone input.
            pass

    def start(self) -> None:
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype=DTYPE,
            blocksize=MIC_BLOCK_SAMPLES,
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class SpeakerPlayback:
    """Pulls PCM16 chunks from a thread-safe ring buffer and plays them."""

    def __init__(self) -> None:
        # Pre-allocated ring buffer of int16 samples.  Sized for ~6 s of
        # audio @ 24 kHz, which is well above the latency we care about
        # but still small enough to drop quickly on barge-in.
        self._buffer = np.zeros(SAMPLE_RATE * 6, dtype=np.int16)
        self._read = 0
        self._write = 0
        self._available = 0
        self._mutex = threading.Lock()
        self._stream: Optional[sd.OutputStream] = None

    # -- thread-safe ring buffer -------------------------------------------
    def _push(self, samples: np.ndarray) -> None:
        with self._mutex:
            n = len(samples)
            cap = len(self._buffer)
            if n >= cap:
                samples = samples[-cap:]
                n = cap
            end = self._write + n
            if end <= cap:
                self._buffer[self._write:end] = samples
            else:
                first = cap - self._write
                self._buffer[self._write:] = samples[:first]
                self._buffer[: n - first] = samples[first:]
            self._write = (self._write + n) % cap
            self._available = min(cap, self._available + n)
            if self._available == cap:
                # Overflow: drop oldest by advancing the read pointer.
                self._read = self._write

    def _pull(self, n: int) -> np.ndarray:
        with self._mutex:
            cap = len(self._buffer)
            take = min(n, self._available)
            out = np.zeros(n, dtype=np.int16)
            if take == 0:
                return out
            end = self._read + take
            if end <= cap:
                out[:take] = self._buffer[self._read:end]
            else:
                first = cap - self._read
                out[:first] = self._buffer[self._read:]
                out[first:take] = self._buffer[: take - first]
            self._read = (self._read + take) % cap
            self._available -= take
            return out

    # -- public API --------------------------------------------------------
    def enqueue(self, samples: np.ndarray) -> None:
        self._push(samples)

    def clear(self) -> None:
        """Flush pending audio (used when the model gets interrupted)."""
        with self._mutex:
            self._read = self._write
            self._available = 0

    def _callback(self, outdata, frames, time_info, status) -> None:
        if status:
            print(f"[spk] {status}", file=sys.stderr)
        chunk = self._pull(frames)
        outdata[:, 0] = chunk

    def start(self) -> None:
        self._stream = sd.OutputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype=DTYPE,
            blocksize=PLAYBACK_BLOCK_SAMPLES,
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


# ----------------------------------------------------------------------------
# Realtime session
# ----------------------------------------------------------------------------
async def configure_session(ws: WebSocketClientProtocol) -> None:
    """Send the initial session.update with translator instructions and VAD."""
    await ws.send(json.dumps({
        "type": "session.update",
        "session": {
            "modalities": ["audio", "text"],
            "voice": VOICE,
            "instructions": INSTRUCTIONS,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            # Server VAD keeps the pipeline continuous: as soon as the
            # speaker pauses, a response is committed and starts streaming
            # back, in parallel with whatever the user says next.
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 200,
                "silence_duration_ms": 350,
                "create_response": True,
                "interrupt_response": True,
            },
            # We want the model to translate, not transcribe verbatim, so we
            # leave input_audio_transcription off to reduce extra work.
            "temperature": 0.6,
        },
    }))


async def pump_microphone(
    ws: WebSocketClientProtocol,
    mic: MicCapture,
) -> None:
    """Forward mic chunks to the Realtime API as input_audio_buffer.append."""
    while True:
        chunk = await mic.queue.get()
        await ws.send(json.dumps({
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(chunk).decode("ascii"),
        }))


async def pump_responses(
    ws: WebSocketClientProtocol,
    speaker: SpeakerPlayback,
) -> None:
    """Read server events and route audio deltas to the speaker."""
    async for raw in ws:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "response.audio.delta":
            # Streaming audio chunk -> push straight into the playback ring.
            samples = pcm16_from_b64(event["delta"])
            speaker.enqueue(samples)

        elif etype == "response.audio_transcript.delta":
            # Optional: print the translated text as it streams.
            sys.stdout.write(event.get("delta", ""))
            sys.stdout.flush()

        elif etype == "response.audio_transcript.done":
            sys.stdout.write("\n")
            sys.stdout.flush()

        elif etype == "input_audio_buffer.speech_started":
            # Barge-in: user started talking again.  Drop any audio still
            # queued for playback so the new translation can take over
            # without overlapping the previous one.
            speaker.clear()

        elif etype == "response.done":
            pass  # nothing to do; next response is already on its way

        elif etype == "error":
            print(f"\n[api error] {event.get('error')}", file=sys.stderr)


async def run() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        sys.exit(1)

    loop = asyncio.get_running_loop()
    mic = MicCapture(loop)
    speaker = SpeakerPlayback()

    # Connect first, then start audio devices so we never drop the very
    # first mic chunk on the floor before the WebSocket is ready.
    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Beta": "realtime=v1",
    }
    async with websockets.connect(
        REALTIME_URL,
        extra_headers=headers,
        max_size=1 << 24,   # allow large audio frames
        ping_interval=20,
        ping_timeout=20,
    ) as ws:
        await configure_session(ws)

        mic.start()
        speaker.start()
        print("Listening. Speak Italian or English; the translation will start "
              "playing as soon as you pause. Ctrl+C to quit.")

        stop_event = asyncio.Event()

        def _request_stop(*_: object) -> None:
            stop_event.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _request_stop)
            except NotImplementedError:
                # Windows: fall back to KeyboardInterrupt
                signal.signal(sig, lambda *_: _request_stop())

        mic_task = asyncio.create_task(pump_microphone(ws, mic))
        rsp_task = asyncio.create_task(pump_responses(ws, speaker))
        stop_task = asyncio.create_task(stop_event.wait())

        try:
            done, pending = await asyncio.wait(
                {mic_task, rsp_task, stop_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, asyncio.CancelledError):
                    raise exc
        finally:
            mic.stop()
            speaker.stop()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
