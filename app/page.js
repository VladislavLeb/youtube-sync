"use client";

import { uploadPresigned } from "@vercel/blob/client";
import { Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

const PLAYING_SYNC_INTERVAL_MS = 2000;
const PAUSED_SYNC_INTERVAL_MS = 3000;
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

function extractYouTubePlaylistId(input) {
  try {
    const url = new URL(input.trim());
    const playlistId = url.searchParams.get("list");
    return /^[a-zA-Z0-9_-]{10,100}$/.test(playlistId || "") ? playlistId : null;
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

export default function Page() {
  const [mode, setMode] = useState(MEDIA_YOUTUBE);
  const [queueUrl, setQueueUrl] = useState("");
  const [queueInputOpen, setQueueInputOpen] = useState(false);
  const [loadingYoutubePlaylist, setLoadingYoutubePlaylist] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading YouTube player...");
  const [lastState, setLastState] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [liveStatus, setLiveStatus] = useState("Live DJ disconnected.");
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveVolume, setLiveVolume] = useState(80);
  const [uploadingMp3, setUploadingMp3] = useState(false);
  const [autoplayUnlocked, setAutoplayUnlocked] = useState(false);
  const [treeBursts, setTreeBursts] = useState([]);
  const [treeShake, setTreeShake] = useState({ side: null, id: 0 });

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
  const lastAdvanceAudioIdRef = useRef(null);
  const lastAdvanceYoutubeVideoIdRef = useRef(null);
  const treeBurstIdRef = useRef(0);
  const clientIdRef = useRef(null);
  const selectedModeRef = useRef(MEDIA_YOUTUBE);

  function rememberState(state) {
    lastStateRef.current = state;
    setLastState(state);
  }

  function shakeTree(side) {
    const batchId = ++treeBurstIdRef.current;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const treeWidth = Math.min(
      viewportWidth * 0.16,
      230,
      (viewportWidth - 980) / 2 - 18
    );
    const treeHeight = treeWidth * (4 / 3);
    const leaves = Array.from({ length: 14 }, (_, index) => {
      const fromLeftTree = side === "left";
      const horizontalDrift = 8 + Math.random() * 20;
      const treeCenterX = fromLeftTree
        ? 8 + treeWidth / 2
        : viewportWidth - 8 - treeWidth / 2;
      const horizontalJitter = (Math.random() - 0.5) * treeWidth * 0.6;
      const treeTop = viewportHeight - 14 - treeHeight;
      const canopyOffset = 0.16 + Math.random() * 0.42;
      const burstTop = ((treeTop + treeHeight * canopyOffset) / viewportHeight) * 100;

      return {
        id: `${batchId}-${index}`,
        batchId,
        style: {
          "--burst-left": `${((treeCenterX + horizontalJitter) / viewportWidth) * 100}%`,
          "--burst-top": `${burstTop}%`,
          "--burst-size": `${20 + Math.random() * 16}px`,
          "--burst-duration": `${2.4 + Math.random() * 1.3}s`,
          "--burst-delay": `${Math.random() * 0.45}s`,
          "--burst-drift": `${(fromLeftTree ? 1 : -1) * horizontalDrift}vw`,
          backgroundPosition: ["0% 0%", "100% 0%", "0% 100%", "100% 100%"][index % 4],
        },
      };
    });

    setTreeShake({ side, id: batchId });
    setTreeBursts((current) => [...current.slice(-28), ...leaves]);
    window.setTimeout(() => {
      setTreeBursts((current) => current.filter((leaf) => leaf.batchId !== batchId));
    }, 5000);
  }

  function shouldIgnoreIncomingState(state) {
    return (
      selectedModeRef.current === MEDIA_MP3 &&
      state?.mediaType !== MEDIA_MP3
    ) || selectedModeRef.current === MEDIA_LIVE;
  }

  async function send(action, payload = {}, options = {}) {
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

      if (options.applyLocal !== false) {
        applyState(data, false);
      }

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
      player.stopVideo?.();
      currentVideoIdRef.current = null;
      setStatus("No video loaded yet.");
      applyingRemoteRef.current = false;
      return;
    }

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
      ? state.time + MP3_SYNC_LEAD_SECONDS + loadingDelay
      : state.time;
    const duration = Number.isFinite(audio.duration) ? audio.duration : targetTime;
    const safeTargetTime = Math.min(targetTime, duration);
    const diff = Math.abs(audio.currentTime - safeTargetTime);

    currentAudioIdRef.current = state.audioId;
    lastAdvanceAudioIdRef.current = null;

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

    if (shouldIgnoreIncomingState(state)) {
      applyingRemoteRef.current = false;
      return;
    }

    rememberState(state);

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

    if (event.data === window.YT.PlayerState.ENDED) {
      advanceYoutubeQueue();
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
    if (mode === MEDIA_LIVE) {
      clientIdRef.current = null;
      return undefined;
    }

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
    }, 10000);

    window.addEventListener("pagehide", sendLeave);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", sendLeave);
      postPresence("leave");
      clientIdRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    if (mode === MEDIA_LIVE) {
      return undefined;
    }

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

        if (state.version !== lastVersionRef.current) {
          lastVersionRef.current = state.version;
          applyState(state, false);
          return;
        }

        if (!shouldIgnoreIncomingState(state)) {
          rememberState(state);
        }

        const now = Date.now();

        if (state.playing && now - lastSoftSyncAtRef.current > 10000) {
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
  }, [mode]);

  useEffect(() => {
    return () => {
      liveRoomRef.current?.disconnect();
    };
  }, []);

  async function addYoutubeVideoToQueue() {
    const playlistId = extractYouTubePlaylistId(queueUrl);

    if (playlistId) {
      setLoadingYoutubePlaylist(true);
      setStatus("Loading YouTube playlist...");

      try {
        const response = await fetch(`/api/youtube-playlist?list=${encodeURIComponent(playlistId)}`, {
          cache: "no-store",
        });
        const data = await response.json();

        if (!response.ok) {
          alert(data.error || "Could not load the YouTube playlist.");
          return;
        }

        const titles = Object.fromEntries(data.videos.map(({ videoId, title }) => [videoId, title]));
        const nextState = await send("appendYoutubeBatch", {
          videoIds: data.videos.map(({ videoId }) => videoId),
          titles,
        });

        if (nextState) {
          setQueueUrl("");
          setQueueInputOpen(false);
          setStatus(
            data.truncated
              ? `Added the first ${data.videos.length} videos from the playlist.`
              : `Added ${data.videos.length} videos from the playlist.`
          );
        }
      } catch (error) {
        console.error(error);
        alert("Could not load the YouTube playlist. Please try again.");
      } finally {
        setLoadingYoutubePlaylist(false);
      }

      return;
    }

    const videoId = extractYouTubeId(queueUrl);

    if (!videoId) {
      alert("Could not recognize the YouTube link.");
      return;
    }

    const nextState = await send("appendYoutube", { videoId });
    if (nextState) {
      setQueueUrl("");
      setQueueInputOpen(false);
    }
  }

  async function advanceYoutubeQueue() {
    const state = lastStateRef.current;
    const videoId = currentVideoIdRef.current;
    const advanceKey = `${Number(state?.currentVideoIndex || 0)}:${videoId}`;

    if (
      applyingRemoteRef.current ||
      !videoId ||
      state?.mediaType === MEDIA_MP3 ||
      lastAdvanceYoutubeVideoIdRef.current === advanceKey
    ) {
      return;
    }

    lastAdvanceYoutubeVideoIdRef.current = advanceKey;
    await send("advanceYoutube", {
      videoId,
      currentVideoIndex: Number(state?.currentVideoIndex || 0),
    });
  }

  async function removeYoutubeVideoFromQueue(index) {
    await send("removeYoutube", { index });
  }

  async function playYoutubeQueueVideo(index) {
    lastAdvanceYoutubeVideoIdRef.current = null;
    await send("selectYoutube", { index });
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
    selectedModeRef.current = MEDIA_MP3;
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
    lastAdvanceAudioIdRef.current = null;

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
    element.volume = liveVolume / 100;
    element.dataset.livekitAudio = "true";
    container.appendChild(element);
  }

  function changeLiveVolume(value) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(Math.max(nextVolume, 0), 100);
    setLiveVolume(clampedVolume);

    liveAudioContainerRef.current
      ?.querySelectorAll("audio")
      .forEach((element) => {
        element.volume = clampedVolume / 100;
      });
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
    const state = lastStateRef.current;

    if (applyingRemoteRef.current || state?.mediaType !== MEDIA_MP3 || !state.audioId) {
      return;
    }

    if (lastAdvanceAudioIdRef.current === state.audioId) {
      return;
    }

    lastAdvanceAudioIdRef.current = state.audioId;

    await send("advanceTrack", {
      audioId: state.audioId,
      currentTrackIndex: state.currentTrackIndex,
      version: state.version,
    });
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

    const mediaType = lastStateRef.current?.mediaType || mode;
    const time = getActiveTime();

    if (mediaType === MEDIA_MP3) {
      const audio = audioRef.current;

      if (audio) {
        const playPromise = audio.play();

        if (playPromise) {
          playPromise.catch(() => {
            setStatus("Autoplay blocked. Press the MP3 play button once.");
          });
        }
      }
    }

    await send("play", {
      mediaType,
      time,
    }, {
      applyLocal: mediaType !== MEDIA_MP3,
    });
  }

  async function pauseForEveryone() {
    if (!hasActiveMedia()) {
      alert(mode === MEDIA_MP3 ? "Load an MP3 first." : "Load a video first.");
      return;
    }

    const mediaType = lastStateRef.current?.mediaType || mode;

    if (mediaType === MEDIA_MP3) {
      audioRef.current?.pause();
    }

    await send("pause", {
      mediaType,
      time: getActiveTime(),
    }, {
      applyLocal: mediaType !== MEDIA_MP3,
    });
  }

  async function syncCurrentTime() {
    if (!hasActiveMedia()) {
      alert(mode === MEDIA_MP3 ? "Load an MP3 first." : "Load a video first.");
      return;
    }

    const mediaType = lastStateRef.current?.mediaType || mode;

    await send("seek", {
      mediaType,
      time: getActiveTime(),
    }, {
      applyLocal: mediaType !== MEDIA_MP3,
    });
  }

  function syncMp3Seek() {
    if (applyingRemoteRef.current || lastStateRef.current?.mediaType !== MEDIA_MP3) {
      return;
    }

    const audio = audioRef.current;

    if (!audio || !lastStateRef.current?.audioUrl) {
      return;
    }

    send("seek", {
      mediaType: MEDIA_MP3,
      time: audio.currentTime || 0,
    }, {
      applyLocal: false,
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
          setAutoplayUnlocked(true);
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
      setAutoplayUnlocked(true);
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
        setAutoplayUnlocked(true);
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
  const youtubeQueue = Array.isArray(lastState?.youtubeQueue) ? lastState.youtubeQueue : [];
  const youtubeTitles = lastState?.youtubeTitles || {};
  const currentVideoIndex = Number(lastState?.currentVideoIndex || 0);
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
      <div className="leafFall" aria-hidden="true">
        {treeBursts.map((leaf) => (
          <span className="burstLeaf" key={leaf.id} style={leaf.style} />
        ))}
        {Array.from({ length: 14 }, (_, index) => (
          <span
            key={index}
            style={{
              "--leaf-left": `${(index * 37 + 8) % 100}%`,
              "--leaf-delay": `${-index * 1.9}s`,
              "--leaf-duration": `${13 + (index % 6) * 2}s`,
              "--leaf-drift": `${(index % 2 === 0 ? 1 : -1) * (12 + (index % 5) * 5)}vw`,
              "--leaf-size": `${30 + (index % 4) * 8}px`,
              backgroundPosition: ["0% 0%", "100% 0%", "0% 100%", "100% 100%"][index % 4],
            }}
          />
        ))}
      </div>
      <button
        aria-label="Shake the golden autumn tree"
        className={`treeButton treeButtonLeft ${treeShake.side === "left" ? "shaking" : ""}`}
        key={`left-tree-${treeShake.side === "left" ? treeShake.id : 0}`}
        onClick={() => shakeTree("left")}
        type="button"
      >
        <span aria-hidden="true" className="treeImage treeImageLeft" />
      </button>
      <button
        aria-label="Shake the red autumn tree"
        className={`treeButton treeButtonRight ${treeShake.side === "right" ? "shaking" : ""}`}
        key={`right-tree-${treeShake.side === "right" ? treeShake.id : 0}`}
        onClick={() => shakeTree("right")}
        type="button"
      >
        <span aria-hidden="true" className="treeImage treeImageRight" />
      </button>
      <section className="card" inert={!autoplayUnlocked}>
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

            <div className="youtubeQueuePanel">
              <div className="youtubeQueueHeader">
                <strong>Video queue</strong>
                <button
                  className="secondaryButton"
                  onClick={() => setQueueInputOpen((open) => !open)}
                  type="button"
                >
                  Add video
                </button>
              </div>

              {queueInputOpen && (
                <div className="inputRow queueInputRow">
                  <input
                    className="queueUrlInput"
                    disabled={loadingYoutubePlaylist}
                    onChange={(event) => setQueueUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addYoutubeVideoToQueue();
                    }}
                    placeholder="YouTube video or playlist link"
                    value={queueUrl}
                  />
                  <button
                    className="queueAddButton"
                    disabled={loadingYoutubePlaylist}
                    onClick={addYoutubeVideoToQueue}
                    type="button"
                  >
                    {loadingYoutubePlaylist ? "Loading..." : "Add to queue"}
                  </button>
                </div>
              )}

              {youtubeQueue.length > 0 ? (
                <ol className="youtubeQueueList">
                  {youtubeQueue.map((videoId, index) => (
                    <li className={index === currentVideoIndex ? "current" : ""} key={`${videoId}-${index}`}>
                      <span className="youtubeQueueEntry">
                        <span>{index === currentVideoIndex ? "Now" : `${index + 1}.`} </span>
                        <button
                          className="youtubeQueueSelect"
                          onClick={() => playYoutubeQueueVideo(index)}
                          type="button"
                        >
                          {youtubeTitles[videoId] || videoId}
                        </button>
                      </span>
                      <button
                        aria-label={`Remove video ${videoId} from queue`}
                        className="removeButton youtubeRemoveButton"
                        onClick={() => removeYoutubeVideoFromQueue(index)}
                        type="button"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="emptyPlaylist">Add video links to play them one after another.</div>
              )}
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

              <label className="volumeControl">
                <span>Volume</span>
                <input
                  max="100"
                  min="0"
                  onChange={(event) => changeLiveVolume(event.target.value)}
                  type="range"
                  value={liveVolume}
                />
                <span>{liveVolume}%</span>
              </label>

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
                }, {
                  applyLocal: false,
                });
              }
            }}
            onPlay={() => {
              if (!applyingRemoteRef.current && lastStateRef.current?.audioUrl) {
                send("play", {
                  mediaType: MEDIA_MP3,
                  time: audioRef.current?.currentTime || 0,
                }, {
                  applyLocal: false,
                });
              }
            }}
            onSeeked={syncMp3Seek}
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
      {!autoplayUnlocked && (
        <div className="autoplayGate" role="dialog" aria-modal="true" aria-labelledby="autoplay-gate-title">
          <div className="autoplayGateCard">
            <h2 id="autoplay-gate-title">Unlock autoplay to continue</h2>
            <p>Wait for the player to load, then click the button to enable autoplay and open the site.</p>
            <button
              onClick={unlockAutoplay}
              disabled={uploadingMp3 || (mode === MEDIA_YOUTUBE && !ready)}
              type="button"
            >
              Unlock autoplay
            </button>
            {mode === MEDIA_YOUTUBE && !ready && <small>The player is loading. The button will be available when it is ready.</small>}
          </div>
        </div>
      )}
    </main>
  );
}
