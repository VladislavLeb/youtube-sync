#!/usr/bin/env python3
import argparse
import asyncio
import json
import signal
import urllib.error
import urllib.request
from typing import Optional

import numpy as np
import sounddevice as sd
from livekit import rtc


SAMPLE_RATE = 48000
DEFAULT_CHANNELS = 2
FRAME_SAMPLES = 960


def print_input_devices() -> None:
    devices = sd.query_devices()

    for index, device in enumerate(devices):
        if device["max_input_channels"] <= 0:
            continue

        print(
            f"{index}: {device['name']} "
            f"({device['max_input_channels']} input channels, "
            f"default samplerate {device['default_samplerate']})"
        )


def get_channel_count(device: Optional[int], requested_channels: Optional[int]) -> int:
    device_info = sd.query_devices(device, "input")
    max_channels = int(device_info["max_input_channels"])

    if max_channels <= 0:
        raise RuntimeError(f"Device {device} has no input channels")

    if requested_channels is not None:
        if requested_channels < 1:
            raise RuntimeError("--channels must be at least 1")

        if requested_channels > max_channels:
            raise RuntimeError(
                f"Device {device} supports only {max_channels} input channel(s), "
                f"but --channels={requested_channels} was requested"
            )

        return requested_channels

    return min(DEFAULT_CHANNELS, max_channels)


def fetch_livekit_token(app_url: str, identity: str) -> dict:
    payload = json.dumps({
        "identity": identity,
        "role": "dj",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{app_url.rstrip('/')}/api/livekit-token",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Token endpoint failed with HTTP {error.code}: {body}"
        ) from error

    if "token" not in data or "livekitUrl" not in data:
        raise RuntimeError(f"Token endpoint returned invalid response: {data}")

    return data


async def publish_audio(
    app_url: str,
    identity: str,
    device: Optional[int],
    requested_channels: Optional[int],
) -> None:
    token_data = fetch_livekit_token(app_url, identity)
    channels = get_channel_count(device, requested_channels)
    room = rtc.Room()
    source = rtc.AudioSource(SAMPLE_RATE, channels, queue_size_ms=1000)
    track = rtc.LocalAudioTrack.create_audio_track("dj-audio", source)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=50)

    def handle_signal() -> None:
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    def audio_callback(indata, frames, time_info, status) -> None:
        if status:
            print(status)

        chunk = indata.copy()

        def enqueue() -> None:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(chunk)

        loop.call_soon_threadsafe(enqueue)

    await room.connect(token_data["livekitUrl"], token_data["token"])
    await room.local_participant.publish_track(track)
    print(f"Connected to LiveKit room '{token_data['room']}' as {identity}")
    print(f"Using device {device if device is not None else 'default'} with {channels} channel(s).")
    print("Streaming audio. Press Ctrl+C to stop.")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=channels,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            device=device,
            callback=audio_callback,
        ):
            while not stop_event.is_set():
                chunk = await queue.get()
                frame = rtc.AudioFrame(
                    data=chunk.tobytes(),
                    sample_rate=SAMPLE_RATE,
                    num_channels=channels,
                    samples_per_channel=len(chunk),
                )
                await source.capture_frame(frame)
    finally:
        await source.wait_for_playout()
        await room.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish local system/app audio to LiveKit.")
    parser.add_argument("--app-url", required=True, help="Your app URL, for example https://example.vercel.app")
    parser.add_argument("--identity", default="dj", help="LiveKit participant identity")
    parser.add_argument("--device", type=int, default=None, help="sounddevice input device index")
    parser.add_argument("--channels", type=int, default=None, help="Input channels to capture, defaults to 2 or device maximum")
    parser.add_argument("--list-devices", action="store_true", help="List audio devices and exit")
    args = parser.parse_args()

    if args.list_devices:
        print_input_devices()
        return

    asyncio.run(publish_audio(args.app_url, args.identity, args.device, args.channels))


if __name__ == "__main__":
    main()
