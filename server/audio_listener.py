"""
Spotify loopback audio beat detector for the Workshop Jukebox.

Captures what the computer's speakers output (WASAPI loopback on Windows),
runs spectral-flux onset detection per frequency band, and broadcasts beat
events over WebSocket (ws://localhost:8765) so the neon ring visualizer in
the browser can flash in time with real music.

Run:
    pip install pyaudiowpatch numpy websockets
    python audio_listener.py

Then open http://localhost:3000/display, click Ring + Audio, play Spotify.
"""

import asyncio
import json
import queue
import signal
import sys
import time

import numpy as np
import pyaudiowpatch as pya
import websockets

WS_HOST = "localhost"
WS_PORT = 8765

# ═════════════════════════════════════════════════════════════════════════════
# RESPONSIVENESS KNOBS
# ═════════════════════════════════════════════════════════════════════════════

# Threshold multiplier over adaptive noise floor (median + K * MAD).
SENSITIVITY_K = 4.0

# Absolute minimum flux to ever count (ignores near-silence).
ABS_MIN_FLUX = 8e-5

# Minimum ms between beats on the SAME band.
MIN_INTERVAL_MS = 60

# Global cooldown across ALL bands (ms).
GLOBAL_COOLDOWN_MS = 30

# Frames to collect before setting noise floor. Lower = faster startup.
CALIBRATION_FRAMES = 50

# Flux smoothing (0.1 = very smooth/slow, 1.0 = raw/instant).
SMOOTH_ALPHA = 0.55

# After a beat fires, flux must drop to this fraction of threshold before re-arming.
REARM_RATIO = 0.4

# If disarmed for longer than this (ms), force re-arm even if flux is still high.
# Prevents getting stuck during sustained loud passages.
FORCE_REARM_MS = 400

# Reject beats weaker than this normalized energy (0.0–1.0).
MIN_BEAT_ENERGY = 0.08

# RMS gate: below this, skip detection (silence).
RMS_GATE = 0.002

# Frequency bands (Hz).
BASS_LO, BASS_HI = 20, 150
MID_LO, MID_HI = 150, 4000
TREBLE_LO, TREBLE_HI = 4000, 20000

# FFT frame size. 512 @ 48kHz ≈ 10.7ms per frame.
FFT_SIZE = 512

# ═════════════════════════════════════════════════════════════════════════════

beat_queue: queue.Queue = queue.Queue()
_shutdown = False


class BandDetector:
    """Spectral-flux onset detector with hysteresis + stuck timeout.

    Fires once when flux rises above threshold, then disarms until flux falls
    back below REARM_RATIO * threshold. If it stays disarmed longer than
    FORCE_REARM_MS (sustained loud passage), it force-re-arms so beats keep
    firing.
    """

    def __init__(self, name: str):
        self.name = name
        self.prev_mag = None
        self.smoothed_flux = 0.0
        self.last_beat = 0.0  # ms
        self.armed = True
        self.disarmed_since = 0.0  # ms when we last disarmed
        self.calibrated = False
        self.calibration_count = 0
        self.flux_history = []
        self.median_flux = 0.0
        self.mad_flux = 0.0

    def _calibrate(self):
        if len(self.flux_history) < CALIBRATION_FRAMES:
            return
        arr = np.array(self.flux_history)
        self.median_flux = float(np.median(arr))
        self.mad_flux = float(np.median(np.abs(arr - self.median_flux)))
        self.calibrated = True
        thr = self.median_flux + SENSITIVITY_K * self.mad_flux
        print(
            f"[{self.name}] calibrated "
            f"median={self.median_flux:.6f} mad={self.mad_flux:.6f} "
            f"threshold={thr:.6f}",
            flush=True,
        )

    def feed(self, raw_flux: float, now_ms: float):
        # Smooth flux — higher alpha = faster tracking, more jitter
        self.smoothed_flux = (
            SMOOTH_ALPHA * raw_flux + (1.0 - SMOOTH_ALPHA) * self.smoothed_flux
        )
        flux = self.smoothed_flux

        self.flux_history.append(flux)
        if len(self.flux_history) > 400:
            self.flux_history.pop(0)

        self.calibration_count += 1
        if not self.calibrated:
            self._calibrate()

        if not self.calibrated or self.mad_flux < 1e-9:
            return None

        floor = max(self.median_flux, 1e-6)
        threshold = floor + SENSITIVITY_K * self.mad_flux
        effective_threshold = max(threshold, max(floor * 1.5, ABS_MIN_FLUX))
        drop_threshold = effective_threshold * REARM_RATIO

        if self.armed:
            # Waiting for a rise above threshold
            if flux > effective_threshold and (now_ms - self.last_beat) > MIN_INTERVAL_MS:
                self.armed = False
                self.disarmed_since = now_ms
                self.last_beat = now_ms
                energy = min((flux - effective_threshold) / max(effective_threshold, 1e-6), 1.0)
                if energy < MIN_BEAT_ENERGY:
                    return None
                return max(energy, MIN_BEAT_ENERGY)
        else:
            # In a beat: wait for flux to fall back down before re-arming
            if flux < drop_threshold:
                self.armed = True
            elif now_ms - self.disarmed_since > FORCE_REARM_MS:
                # Stuck in sustained loud passage — force re-arm so beats keep coming
                self.armed = True
                self.disarmed_since = now_ms

        return None


bass_det = BandDetector("bass")
mid_det = BandDetector("mid")
treble_det = BandDetector("treble")

_last_print_ms = 0.0
_prev_mags = {}
_last_global_beat_ms = 0.0


def band_flux(mono: np.ndarray, rate: int, prev_mags: dict):
    """Spectral flux per band: sum of positive magnitude differences vs previous frame.

    Only counts energy *increases* (onsets), not decreases.
    """
    n = len(mono)
    if n < 64:
        return 0.0, 0.0, 0.0, prev_mags

    # Pad or trim to FFT_SIZE for consistent frequency resolution
    if n < FFT_SIZE:
        padded = np.zeros(FFT_SIZE)
        padded[:n] = mono
        mono = padded
        n = FFT_SIZE
    elif n > FFT_SIZE:
        mono = mono[:FFT_SIZE]
        n = FFT_SIZE

    window = np.hanning(n)
    fft = np.fft.rfft(mono * window)
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    mag = np.abs(fft)

    def band_val(lo, hi, key):
        mask = (freqs >= lo) & (freqs < hi)
        if not np.any(mask):
            return 0.0
        current = mag[mask]
        prev = prev_mags.get(key)
        if prev is None or len(prev) != len(current):
            prev_mags[key] = current
            return 0.0
        diff = current - prev
        return float(np.sum(np.maximum(diff, 0)))

    bass = band_val(BASS_LO, BASS_HI, "bass")
    mid = band_val(MID_LO, MID_HI, "mid")
    treble = band_val(TREBLE_LO, TREBLE_HI, "treble")

    return bass, mid, treble, prev_mags


async def ws_handler(websocket):
    loop = asyncio.get_running_loop()
    try:
        while True:
            beat = await loop.run_in_executor(None, beat_queue.get)
            await websocket.send(json.dumps(beat))
    except websockets.exceptions.ConnectionClosed:
        pass


def audio_callback(in_data, frame_count, time_info, status):
    global _last_print_ms, _prev_mags, _last_global_beat_ms

    if status:
        print("Audio status:", status, flush=True)

    audio_data = np.frombuffer(in_data, dtype=np.float32)
    if audio_data.size == 0:
        return (in_data, pya.paContinue)

    # Loopback is stereo; average to mono
    channels = 2
    if audio_data.size % channels == 0:
        mono = audio_data.reshape(-1, channels).mean(axis=1)
    else:
        mono = audio_data

    rate = audio_callback.sample_rate

    bass_f, mid_f, treble_f, _prev_mags = band_flux(mono, rate, _prev_mags)

    # RMS gate — skip if near silence
    rms = float(np.sqrt(np.mean(mono ** 2)))
    if rms < RMS_GATE:
        return (in_data, pya.paContinue)

    now_ms = time.time() * 1000

    # Global cooldown across all bands
    if (now_ms - _last_global_beat_ms) < GLOBAL_COOLDOWN_MS:
        # Still update detector states so they don't get stuck waiting
        bass_det.feed(bass_f, now_ms)
        mid_det.feed(mid_f, now_ms)
        treble_det.feed(treble_f, now_ms)
        return (in_data, pya.paContinue)

    bass_beat = bass_det.feed(bass_f, now_ms)
    mid_beat = mid_det.feed(mid_f, now_ms)
    treble_beat = treble_det.feed(treble_f, now_ms)

    beats = [
        (bass_beat, "bass", bass_f),
        (mid_beat, "mid", mid_f),
        (treble_beat, "treble", treble_f),
    ]
    beats = [b for b in beats if b[0] is not None]

    if beats:
        beats.sort(key=lambda x: x[0], reverse=True)
        energy, band_name, band_val = beats[0]
        _last_global_beat_ms = now_ms
        beat_msg = {
            "event": "beat",
            "timestamp": now_ms,
            "energy": energy,
            "band": band_name,
            "bass": bass_f,
            "mid": mid_f,
            "treble": treble_f,
            "rms": rms,
        }
        print(
            f"[BEAT] {band_name} e={energy:.2f} "
            f"b={bass_f:.5f} m={mid_f:.5f} t={treble_f:.5f} rms={rms:.5f}",
            flush=True,
        )
        try:
            beat_queue.put_nowait(beat_msg)
        except Exception:
            pass

    # Live debug every 300ms for tuning
    if now_ms - _last_print_ms > 300:
        b_det = bass_det
        thr = (
            max(b_det.median_flux, 1e-6) + SENSITIVITY_K * b_det.mad_flux
            if b_det.calibrated else 0.0
        )
        print(
            f"[LIVE] rms={rms:.5f} "
            f"bass={bass_f:.5f} mid={mid_f:.5f} treble={treble_f:.5f} "
            f"thr={thr:.5f} armed_b={bass_det.armed} armed_m={mid_det.armed} "
            f"armed_t={treble_det.armed}",
            flush=True,
        )
        _last_print_ms = now_ms

    return (in_data, pya.paContinue)


async def main():
    p = pya.PyAudio()
    try:
        loopback = p.get_default_wasapi_loopback()
        device_index = loopback["index"]
        channels = int(loopback.get("maxInputChannels", 2))
        rate = int(loopback.get("defaultSampleRate", 44100))

        audio_callback.sample_rate = rate

        print(f"Loopback device {device_index}: {loopback['name']}", flush=True)
        print(f"Channels: {channels}, Rate: {rate}", flush=True)
        print("Play Spotify now. Watch for [LIVE] and [BEAT] lines.\n", flush=True)

        stream = p.open(
            format=pya.paFloat32,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=FFT_SIZE,
            stream_callback=audio_callback,
        )

        async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
            print(f"Audio listener: ws://{WS_HOST}:{WS_PORT}", flush=True)
            while not _shutdown and stream.is_active():
                await asyncio.sleep(0.2)
    except Exception as e:
        print(f"ERROR: {e}", flush=True)
        print("\nInstall pyaudiowpatch if missing:", flush=True)
        print("  pip install pyaudiowpatch", flush=True)
        raise
    finally:
        p.terminate()


def _handle_signal(signum, frame):
    global _shutdown
    _shutdown = True
    print("\nShutting down...", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
