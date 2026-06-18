"use client";

import { uploadPresigned } from "@vercel/blob/client";
import { Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

const SOFT_SYNC_INTERVAL_MS = 30000;
const MEDIA_YOUTUBE = "youtube";
const MEDIA_MP3 = "mp3";
const MEDIA_LIVE = "live";
const MP3_SYNC_LEAD_SECONDS = 0.35;
const MAX_TOTAL_MP3_BYTES = 500 * 1024 * 1024;

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

function waitForAudioMetadata(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    function cleanup() {
      audio.removeEventListener("loadedmetadata", handleReady);
      audio.removeEventListener("error", handleError);
    }

    function handleReady() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error("Audio metadata failed to load"));
    }

    audio.addEventListener("loadedmetadata", handleReady, { once: true });
    audio.addEventListener("error", handleError, { once: true });
  });
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 MB";
  }

  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function sanitizeFileName(fileName) {
  return String(fileName || "audio.mp3")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "audio.mp3";
}

function getSyncedTime(state) {
  if (!state?.playing) {
    return state?.time || 0;
  }

  return (state.time || 0) + (Date.now() - state.updatedAt) / 1000;
}

export default function Page() {
  const [mode, setMode] = useState(MEDIA_YOUTUBE);
  const [url, setUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading YouTube player...");
  const [lastState, setLastState] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [liveStatus, setLiveStatus] = useState("Live DJ disconnected.");
  const [liveConnected, setLiveConnected] = useState(false);
  const [uploadingMp3, setUploadingMp3] = useState(false);

  const playerRef = useRef(null);
  const audioRef = useRef(null);
  const liveAudioContainerRef = useRef(null);
  const liveRoomRef = useRef(null);
  const playerReadyRef = useRef(false);
  const currentVideoIdRef = useRef(null);
  const currentAudioIdRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const pendingStateRef = useRef(null);
  const lastStateRef = useRef(null);
  const lastVersionRef = useRef(null);
  const lastSoftSyncAtRef = useRef(0);
  const clientIdRef = useRef(null);
  const selectedModeRef = useRef(MEDIA_YOUTUBE);

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

  function applyYouTubeState(state, soft = false) {
    const player = playerRef.current;

    if (!playerReadyRef.current || !player) {
      pendingStateRef.current = state;
      return;
    }

    if (!state.videoId) {
      setStatus("No video loaded yet.");
      applyingRemoteRef.current = false;
      return;
    }

    const targetTime = state.playing ? getSyncedTime(state) + 0.35 : state.time;

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
          ? `Playing YouTube from ${Math.round(targetTime)}s`
          : `Loaded YouTube at ${Math.round(targetTime)}s`
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
      setStatus(`Playing YouTube from ${Math.round(targetTime)}s`);
    } else {
      player.pauseVideo();
      setStatus(`Paused YouTube at ${Math.round(targetTime)}s`);
    }

    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 800);
  }

  async function applyMp3State(state, soft = false) {
    const audio = audioRef.current;
    const startedApplyingAt = Date.now();

    if (!audio) {
      pendingStateRef.current = state;
      return;
    }

    if (!state.audioId) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setAudioUrl(null);
      setStatus("No MP3 loaded yet.");
      applyingRemoteRef.current = false;
      return;
    }

    if (state.audioUrl && audio.src !== new URL(state.audioUrl, window.location.origin).href) {
      audio.src = state.audioUrl;
      audio.load();
      setAudioUrl(state.audioUrl);
    }

    try {
      await waitForAudioMetadata(audio);
    } catch (error) {
      console.warn(error);
      setStatus("MP3 failed to load. Upload it again.");
      applyingRemoteRef.current = false;
      return;
    }

    const loadingDelay = state.playing ? (Date.now() - startedApplyingAt) / 1000 : 0;
    const targetTime = state.playing
      ? getSyncedTime(state) + MP3_SYNC_LEAD_SECONDS + loadingDelay
      : state.time;
    const duration = Number.isFinite(audio.duration) ? audio.duration : targetTime;
    const safeTargetTime = Math.min(targetTime, duration);
    const diff = Math.abs(audio.currentTime - safeTargetTime);

    currentAudioIdRef.current = state.audioId;

    if (!soft || diff > 1.25) {
      audio.currentTime = safeTargetTime;
    }

    if (state.playing) {
      const playPromise = audio.play();

      if (playPromise) {
        playPromise.catch(() => {
          setStatus("Autoplay blocked. Press Play for everyone manually.");
        });
      }

      setStatus(`Playing MP3 from ${Math.round(safeTargetTime)}s`);
    } else {
      audio.pause();
      setStatus(`Paused MP3 at ${Math.round(safeTargetTime)}s`);
    }

    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 500);
  }

  function applyState(state, soft = false) {
    applyingRemoteRef.current = true;
    rememberState(state);

    if (selectedModeRef.current === MEDIA_LIVE) {
      applyingRemoteRef.current = false;
      return;
    }

    if (state.mediaType === MEDIA_MP3) {
      if (state.audioId) {
        selectedModeRef.current = MEDIA_MP3;
        setMode(MEDIA_MP3);
      }
      playerRef.current?.pauseVideo?.();
      applyMp3State(state, soft);
      return;
    }

    if (state.videoId) {
      selectedModeRef.current = MEDIA_YOUTUBE;
      setMode(MEDIA_YOUTUBE);
    }
    audioRef.current?.pause();
    applyYouTubeState(state, soft);
  }

  function onPlayerStateChange(event) {
    if (applyingRemoteRef.current) return;
    if (!playerReadyRef.current) return;
    if (!currentVideoIdRef.current) return;
    if (lastStateRef.current?.mediaType === MEDIA_MP3) return;

    const player = playerRef.current;
    if (!player) return;

    if (event.data === window.YT.PlayerState.PLAYING) {
      send("play", {
        mediaType: MEDIA_YOUTUBE,
        time: player.getCurrentTime(),
      });
    }

    if (event.data === window.YT.PlayerState.PAUSED) {
      send("pause", {
        mediaType: MEDIA_YOUTUBE,
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
          setStatus("Ready. Paste a YouTube link or choose MP3 mode.");

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
    const clientId = crypto.randomUUID();
    clientIdRef.current = clientId;

    function postPresence(action) {
      return fetch("/api/presence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          clientId,
        }),
      }).catch((error) => {
        console.error(error);
      });
    }

    function sendLeave() {
      const body = JSON.stringify({
        action: "leave",
        clientId,
      });

      navigator.sendBeacon(
        "/api/presence",
        new Blob([body], {
          type: "application/json",
        })
      );
    }

    postPresence("heartbeat");
    const intervalId = window.setInterval(() => {
      postPresence("heartbeat");
    }, 30000);

    window.addEventListener("pagehide", sendLeave);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", sendLeave);
      postPresence("leave");
    };
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/sync/events");

    events.addEventListener("sync", (event) => {
      const state = JSON.parse(event.data);

      rememberState(state);

      if (state.version !== lastVersionRef.current) {
        lastVersionRef.current = state.version;
        applyState(state, false);
      }
    });

    events.onerror = (error) => {
      console.error(error);
    };

    return () => {
      events.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      liveRoomRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const state = lastStateRef.current;

      if (!state?.playing) {
        return;
      }

      lastSoftSyncAtRef.current = Date.now();
      applyState(state, true);
    }, SOFT_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  async function loadVideo() {
    const videoId = extractYouTubeId(url);

    if (!videoId) {
      alert("Could not recognize YouTube link.");
      return;
    }

    await send("load", {
      mediaType: MEDIA_YOUTUBE,
      videoId,
    });
  }

  async function loadMp3(file) {
    if (!file) {
      return;
    }

    if (file.type && file.type !== "audio/mpeg" && !file.name.toLowerCase().endsWith(".mp3")) {
      alert("Choose an MP3 file.");
      return;
    }

    setUploadingMp3(true);
    setStatus(`Uploading MP3: ${file.name}`);

    const audioId = crypto.randomUUID();
    const audioName = sanitizeFileName(file.name);
    let blob;

    try {
      const validationRes = await fetch("/api/upload-mp3", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "validate",
          size: file.size,
        }),
      });
      const validation = await validationRes.json();

      if (!validationRes.ok) {
        alert(validation.error || "MP3 upload failed");
        return;
      }

      blob = await uploadPresigned(`mp3/${audioId}-${audioName}`, file, {
        access: "public",
        clientPayload: JSON.stringify({
          size: file.size,
        }),
        contentType: "audio/mpeg",
        handleUploadUrl: "/api/upload-mp3",
        multipart: true,
        onUploadProgress: ({ percentage }) => {
          setStatus(`Uploading MP3: ${file.name} (${Math.round(percentage)}%)`);
        },
      });
    } catch (error) {
      console.error(error);
      alert(error.message || "MP3 upload failed");
      return;
    } finally {
      setUploadingMp3(false);
    }

    setAudioFile(file);
    setAudioUrl(blob.url);
    currentAudioIdRef.current = audioId;
    setMode(MEDIA_MP3);
    setStatus(`Added MP3: ${file.name}`);

    await send("appendMp3", {
      mediaType: MEDIA_MP3,
      audioId,
      audioName,
      audioSize: file.size,
      audioUrl: blob.url,
    });
  }

  async function selectPlaylistTrack(index) {
    await send("selectTrack", {
      index,
    });
  }

  async function removePlaylistTrack(index) {
    await send("removeTrack", {
      index,
    });
  }

  function attachLiveAudioTrack(track) {
    const container = liveAudioContainerRef.current;

    if (!container || track.kind !== Track.Kind.Audio) {
      return;
    }

    const element = track.attach();
    element.autoplay = true;
    element.controls = false;
    element.dataset.livekitAudio = "true";
    container.appendChild(element);
  }

  function detachLiveAudioTrack(track) {
    track.detach().forEach((element) => {
      element.remove();
    });
  }

  async function connectLiveDj() {
    try {
      setLiveStatus("Connecting to Live DJ...");

      const res = await fetch("/api/livekit-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identity: `listener-${crypto.randomUUID()}`,
          role: "listener",
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Could not get LiveKit token");
        setLiveStatus("Live DJ disconnected.");
        return;
      }

      const room = new Room();
      liveRoomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, attachLiveAudioTrack);
      room.on(RoomEvent.TrackUnsubscribed, detachLiveAudioTrack);
      room.on(RoomEvent.Disconnected, () => {
        setLiveConnected(false);
        setLiveStatus("Live DJ disconnected.");
      });

      await room.connect(data.livekitUrl, data.token);

      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          if (publication.track) {
            attachLiveAudioTrack(publication.track);
          }
        });
      });

      setLiveConnected(true);
      setLiveStatus("Listening to Live DJ.");
    } catch (error) {
      console.error(error);
      alert(error.message || "Could not connect to Live DJ");
      setLiveStatus("Live DJ disconnected.");
    }
  }

  function disconnectLiveDj() {
    liveRoomRef.current?.disconnect();
    liveRoomRef.current = null;
    liveAudioContainerRef.current?.replaceChildren();
    setLiveConnected(false);
    setLiveStatus("Live DJ disconnected.");
  }

  async function advancePlaylistTrack() {
    if (applyingRemoteRef.current || lastStateRef.current?.mediaType !== MEDIA_MP3) {
      return;
    }

    await send("advanceTrack");
  }

  function getActiveTime() {
    if (lastStateRef.current?.mediaType === MEDIA_MP3) {
      return audioRef.current?.currentTime || 0;
    }

    return playerRef.current?.getCurrentTime?.() || 0;
  }

  function hasActiveMedia() {
    if (lastStateRef.current?.mediaType === MEDIA_MP3) {
      return Boolean(lastStateRef.current.audioId && lastStateRef.current.audioUrl);
    }

    return Boolean(ready && playerRef.current && currentVideoIdRef.current);
  }

  async function playForEveryone() {
    if (!hasActiveMedia()) {
      alert(mode === MEDIA_MP3 ? "Load an MP3 first." : "Load a video first.");
      return;
    }

    await send("play", {
      mediaType: lastStateRef.current?.mediaType || mode,
      time: getActiveTime(),
    });
  }

  async function pauseForEveryone() {
    if (!hasActiveMedia()) {
      alert(mode === MEDIA_MP3 ? "Load an MP3 first." : "Load a video first.");
      return;
    }

    await send("pause", {
      mediaType: lastStateRef.current?.mediaType || mode,
      time: getActiveTime(),
    });
  }

  async function syncCurrentTime() {
    if (!hasActiveMedia()) {
      alert(mode === MEDIA_MP3 ? "Load an MP3 first." : "Load a video first.");
      return;
    }

    await send("seek", {
      mediaType: lastStateRef.current?.mediaType || mode,
      time: getActiveTime(),
    });
  }

  function unlockAutoplay() {
    if (mode === MEDIA_MP3) {
      const audio = audioRef.current;

      if (!audio || !lastStateRef.current?.audioUrl) {
        return;
      }

      applyingRemoteRef.current = true;
      audio.muted = true;

      audio
        .play()
        .then(() => {
          window.setTimeout(() => {
            audio.pause();
            audio.muted = false;
            applyingRemoteRef.current = false;
            setStatus("MP3 autoplay unlocked. Now press Play for everyone.");
          }, 300);
        })
        .catch(() => {
          audio.muted = false;
          applyingRemoteRef.current = false;
          setStatus("Autoplay blocked. Press Play for everyone manually.");
        });

      return;
    }

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

  function handleModeChange(nextMode) {
    selectedModeRef.current = nextMode;
    setMode(nextMode);

    if (nextMode === MEDIA_MP3) {
      disconnectLiveDj();
      playerRef.current?.pauseVideo?.();
      setStatus(
        audioFile
          ? `Loaded MP3: ${audioFile.name}`
          : "Choose an MP3 file to upload for everyone."
      );
    } else if (nextMode === MEDIA_LIVE) {
      playerRef.current?.pauseVideo?.();
      audioRef.current?.pause();
      setStatus("Live DJ mode.");
    } else {
      disconnectLiveDj();
      audioRef.current?.pause();
      setStatus(ready ? "Ready. Paste a YouTube link." : "Loading YouTube player...");
    }
  }

  const visibleTime = lastState?.time ? `${Math.round(lastState.time)}s` : "0s";
  const playlist = Array.isArray(lastState?.playlist) ? lastState.playlist : [];
  const currentTrackIndex = Number(lastState?.currentTrackIndex || 0);
  const totalPlaylistBytes = playlist.reduce(
    (total, track) => total + Number(track.audioSize || 0),
    0
  );
  const sharedMedia =
    lastState?.mediaType === MEDIA_MP3
      ? lastState.audioName || "MP3"
      : lastState?.videoId || "no video";

  return (
    <main className="page">
      <section className="card">
        <h1>Sync Player</h1>

        <nav className="modeMenu" aria-label="Player mode">
          <button
            className={mode === MEDIA_YOUTUBE ? "active" : ""}
            onClick={() => handleModeChange(MEDIA_YOUTUBE)}
            type="button"
          >
            YouTube
          </button>

          <button
            className={mode === MEDIA_MP3 ? "active" : ""}
            onClick={() => handleModeChange(MEDIA_MP3)}
            type="button"
          >
            MP3
          </button>

          <button
            className={mode === MEDIA_LIVE ? "active" : ""}
            onClick={() => handleModeChange(MEDIA_LIVE)}
            type="button"
          >
            Live DJ
          </button>
        </nav>

        {mode === MEDIA_YOUTUBE ? (
          <>
            <p className="subtitle">
              Paste a YouTube link, load it for everyone, then control playback
              together.
            </p>

            <div className="inputRow">
              <input
                key="youtube-url-input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
              />

              <button onClick={loadVideo} disabled={!ready}>
                Load
              </button>
            </div>
          </>
        ) : mode === MEDIA_MP3 ? (
          <>
            <p className="subtitle">
              Add MP3 files to a shared temporary playlist. Uploads stop at 500
              MB until songs are removed.
            </p>

            <div className="inputRow">
              <input
                accept="audio/mpeg,.mp3"
                disabled={uploadingMp3}
                key="mp3-file-input"
                onChange={(event) => loadMp3(event.target.files?.[0])}
                type="file"
              />
            </div>

            <div className="playlistPanel">
              <div className="playlistHeader">
                <strong>Playlist</strong>
                <span>
                  {formatBytes(totalPlaylistBytes)} / {formatBytes(MAX_TOTAL_MP3_BYTES)}
                </span>
              </div>

              {playlist.length > 0 ? (
                <div className="playlist">
                  {playlist.map((track, index) => (
                    <div
                      className={
                        index === currentTrackIndex
                          ? "playlistItem active"
                          : "playlistItem"
                      }
                      key={track.audioId}
                    >
                      <button
                        className="trackButton"
                        disabled={uploadingMp3}
                        onClick={() => selectPlaylistTrack(index)}
                        type="button"
                      >
                        <span>{track.audioName}</span>
                        <small>{formatBytes(track.audioSize)}</small>
                      </button>

                      <button
                        className="removeButton"
                        disabled={uploadingMp3}
                        onClick={() => removePlaylistTrack(index)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="emptyPlaylist">No MP3 files uploaded.</div>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="subtitle">
              Listen to the DJ stream published from the local Python sender.
            </p>

            <div className="livePanel">
              <div>
                <strong>Live DJ:</strong> {liveStatus}
              </div>

              <button
                onClick={liveConnected ? disconnectLiveDj : connectLiveDj}
                type="button"
              >
                {liveConnected ? "Disconnect Live DJ" : "Listen Live DJ"}
              </button>

              <div ref={liveAudioContainerRef} />
            </div>
          </>
        )}

        {mode !== MEDIA_LIVE && (
          <div className="buttons">
            <button onClick={playForEveryone} disabled={uploadingMp3 || (mode === MEDIA_YOUTUBE && !ready)}>
              Play for everyone
            </button>

            <button onClick={pauseForEveryone} disabled={uploadingMp3 || (mode === MEDIA_YOUTUBE && !ready)}>
              Pause for everyone
            </button>

            <button onClick={syncCurrentTime} disabled={uploadingMp3 || (mode === MEDIA_YOUTUBE && !ready)}>
              Sync current time
            </button>

            <button onClick={unlockAutoplay} disabled={uploadingMp3 || (mode === MEDIA_YOUTUBE && !ready)}>
              Unlock autoplay
            </button>
          </div>
        )}

        {mode !== MEDIA_LIVE && (
          <div className="info">
            <div>
              <strong>Status:</strong> {status}
            </div>

            <div>
              <strong>Shared state:</strong> {sharedMedia} /{" "}
              {lastState?.playing ? "playing" : "paused"} / {visibleTime}
            </div>
          </div>
        )}

        <div className={mode === MEDIA_YOUTUBE ? "playerWrap" : "playerWrap hiddenPlayer"}>
          <div id="player" />
        </div>

        <div className={mode === MEDIA_MP3 ? "audioWrap" : "audioWrap hiddenPlayer"}>
          <audio
            controls
            onEnded={advancePlaylistTrack}
            onPause={() => {
              if (
                !applyingRemoteRef.current &&
                !audioRef.current?.ended &&
                lastStateRef.current?.audioUrl
              ) {
                send("pause", {
                  mediaType: MEDIA_MP3,
                  time: audioRef.current?.currentTime || 0,
                });
              }
            }}
            onPlay={() => {
              if (!applyingRemoteRef.current && lastStateRef.current?.audioUrl) {
                send("play", {
                  mediaType: MEDIA_MP3,
                  time: audioRef.current?.currentTime || 0,
                });
              }
            }}
            ref={audioRef}
            src={audioUrl || undefined}
          />

          <div className="audioMeta">
            {lastState?.audioName || audioFile?.name || "No MP3 selected"}
          </div>
        </div>

        {mode !== MEDIA_LIVE && (
          <p className="hint">
            Each friend should click “Unlock autoplay” once after loading the page.
            Browsers may block autoplay with sound until the user interacts with
            the page.
          </p>
        )}
      </section>
    </main>
  );
}
