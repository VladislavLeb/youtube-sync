"use client";

import { useEffect, useRef, useState } from "react";

const PLAYING_SYNC_INTERVAL_MS = 2000;
const PAUSED_SYNC_INTERVAL_MS = 3000;

function isValidYouTubeId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(value || "");
}

function extractYouTubeId(input) {
  const value = input.trim();

  if (isValidYouTubeId(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return isValidYouTubeId(id) ? id : null;
    }

    const v = url.searchParams.get("v");
    if (isValidYouTubeId(v)) {
      return v;
    }

    const match = url.pathname.match(
        /\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})/
    );

    if (match && isValidYouTubeId(match[1])) {
      return match[1];
    }

    return null;
  } catch {
    return null;
  }
}

export default function Page() {
  const [url, setUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading YouTube player...");
  const [lastState, setLastState] = useState(null);

  const playerRef = useRef(null);
  const playerReadyRef = useRef(false);
  const currentVideoIdRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const pendingStateRef = useRef(null);
  const lastStateRef = useRef(null);
  const lastVersionRef = useRef(null);
  const lastSoftSyncAtRef = useRef(0);

  function rememberState(state) {
    lastStateRef.current = state;
    setLastState(state);
  }

  async function send(action, payload = {}) {
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          ...payload,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Request failed");
        return null;
      }

      lastVersionRef.current = data.version;
      rememberState(data);
      applyState(data, false);

      return data;
    } catch (error) {
      console.error(error);
      alert("Network error");
      return null;
    }
  }

  function applyState(state, soft = false) {
    const player = playerRef.current;

    if (!playerReadyRef.current || !player) {
      pendingStateRef.current = state;
      return;
    }

    if (!state.videoId) {
      setStatus("No video loaded yet.");
      return;
    }

    applyingRemoteRef.current = true;
    rememberState(state);

    const targetTime = state.playing ? state.time + 0.35 : state.time;

    if (currentVideoIdRef.current !== state.videoId) {
      currentVideoIdRef.current = state.videoId;

      if (state.playing) {
        player.loadVideoById({
          videoId: state.videoId,
          startSeconds: targetTime,
        });
      } else {
        player.cueVideoById({
          videoId: state.videoId,
          startSeconds: targetTime,
        });
      }

      setStatus(
          state.playing
              ? `Playing from ${Math.round(targetTime)}s`
              : `Loaded at ${Math.round(targetTime)}s`
      );

      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 1200);

      return;
    }

    const localTime =
        typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0;

    const diff = Math.abs(localTime - targetTime);

    if (!soft || diff > 1.25) {
      player.seekTo(targetTime, true);
    }

    if (state.playing) {
      player.playVideo();
      setStatus(`Playing from ${Math.round(targetTime)}s`);
    } else {
      player.pauseVideo();
      setStatus(`Paused at ${Math.round(targetTime)}s`);
    }

    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 800);
  }

  function onPlayerStateChange(event) {
    if (applyingRemoteRef.current) return;
    if (!playerReadyRef.current) return;
    if (!currentVideoIdRef.current) return;

    const player = playerRef.current;
    if (!player) return;

    if (event.data === window.YT.PlayerState.PLAYING) {
      send("play", {
        time: player.getCurrentTime(),
      });
    }

    if (event.data === window.YT.PlayerState.PAUSED) {
      send("pause", {
        time: player.getCurrentTime(),
      });
    }
  }

  function createYouTubePlayer() {
    if (playerRef.current) return;
    if (!window.YT || !window.YT.Player) return;

    playerRef.current = new window.YT.Player("player", {
      width: "100%",
      height: "100%",
      playerVars: {
        playsinline: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          playerReadyRef.current = true;
          setReady(true);
          setStatus("Ready. Paste a YouTube link.");

          if (pendingStateRef.current) {
            applyState(pendingStateRef.current, false);
            pendingStateRef.current = null;
          }
        },
        onStateChange: onPlayerStateChange,
        onAutoplayBlocked: () => {
          setStatus("Autoplay blocked. Click Unlock autoplay or press Play manually.");
        },
      },
    });
  }

  useEffect(() => {
    window.onYouTubeIframeAPIReady = createYouTubePlayer;

    if (window.YT && window.YT.Player) {
      createYouTubePlayer();
      return;
    }

    const existingScript = document.querySelector(
        'script[src="https://www.youtube.com/iframe_api"]'
    );

    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;

    function scheduleNextPoll(state) {
      if (cancelled) return;

      const delay = state?.playing
          ? PLAYING_SYNC_INTERVAL_MS
          : PAUSED_SYNC_INTERVAL_MS;

      timeoutId = window.setTimeout(poll, delay);
    }

    async function poll() {
      let stateForNextPoll = lastStateRef.current;

      try {
        const res = await fetch("/api/sync", {
          cache: "no-store",
        });

        const state = await res.json();

        if (cancelled) return;

        stateForNextPoll = state;
        rememberState(state);

        if (state.version !== lastVersionRef.current) {
          lastVersionRef.current = state.version;
          applyState(state, false);
          return;
        }

        const now = Date.now();

        if (
            state.playing &&
            now - lastSoftSyncAtRef.current > 10000
        ) {
          lastSoftSyncAtRef.current = now;
          applyState(state, true);
        }
      } catch (error) {
        console.error(error);
      } finally {
        scheduleNextPoll(stateForNextPoll);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  async function loadVideo() {
    const videoId = extractYouTubeId(url);

    if (!videoId) {
      alert("Could not recognize YouTube link.");
      return;
    }

    await send("load", { videoId });
  }

  async function playForEveryone() {
    const player = playerRef.current;

    if (!ready || !player || !currentVideoIdRef.current) {
      alert("Load a video first.");
      return;
    }

    await send("play", {
      time: player.getCurrentTime(),
    });
  }

  async function pauseForEveryone() {
    const player = playerRef.current;

    if (!ready || !player || !currentVideoIdRef.current) {
      alert("Load a video first.");
      return;
    }

    await send("pause", {
      time: player.getCurrentTime(),
    });
  }

  async function syncCurrentTime() {
    const player = playerRef.current;

    if (!ready || !player || !currentVideoIdRef.current) {
      alert("Load a video first.");
      return;
    }

    await send("seek", {
      time: player.getCurrentTime(),
    });
  }

  function unlockAutoplay() {
    const player = playerRef.current;

    if (!ready || !player) {
      return;
    }

    const state = player.getPlayerState?.();

    if (state === window.YT.PlayerState.PLAYING) {
      return;
    }

    applyingRemoteRef.current = true;

    try {
      player.mute();
      player.playVideo();

      setTimeout(() => {
        player.pauseVideo();
        player.unMute();
        applyingRemoteRef.current = false;
        setStatus("Autoplay unlocked. Now press Play for everyone.");
      }, 400);
    } catch {
      applyingRemoteRef.current = false;
    }
  }

  const visibleTime = lastState?.time
      ? `${Math.round(lastState.time)}s`
      : "0s";

  return (
      <main className="page">
        <section className="card">
          <h1>YouTube Sync</h1>

          <p className="subtitle">
            Paste a YouTube link, load it for everyone, then control playback
            together.
          </p>

          <div className="inputRow">
            <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
            />

            <button onClick={loadVideo} disabled={!ready}>
              Load
            </button>
          </div>

          <div className="buttons">
            <button onClick={playForEveryone} disabled={!ready}>
              Play for everyone
            </button>

            <button onClick={pauseForEveryone} disabled={!ready}>
              Pause for everyone
            </button>

            <button onClick={syncCurrentTime} disabled={!ready}>
              Sync current time
            </button>

            <button onClick={unlockAutoplay} disabled={!ready}>
              Unlock autoplay
            </button>
          </div>

          <div className="info">
            <div>
              <strong>Status:</strong> {status}
            </div>

            <div>
              <strong>Shared state:</strong>{" "}
              {lastState?.videoId ? lastState.videoId : "no video"} /{" "}
              {lastState?.playing ? "playing" : "paused"} / {visibleTime}
            </div>
          </div>

          <div className="playerWrap">
            <div id="player" />
          </div>

          <p className="hint">
            Each friend should click “Unlock autoplay” once after loading the
            page. Browsers may block autoplay with sound until the user interacts
            with the page.
          </p>
        </section>
      </main>
  );
}
