import { Redis } from "@upstash/redis";
import { deleteMp3Blob, deletePlaylistBlobs } from "../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();

const ROOM_KEY = "youtube-sync:main";
const MEDIA_YOUTUBE = "youtube";
const MEDIA_MP3 = "mp3";

const emptyState = {
    mediaType: MEDIA_YOUTUBE,
    videoId: null,
    youtubeQueue: [],
    currentVideoIndex: 0,
    youtubeTitles: {},
    audioId: null,
    audioName: null,
    audioSize: 0,
    audioUrl: null,
    playlist: [],
    currentTrackIndex: 0,
    playing: false,
    time: 0,
    updatedAt: Date.now(),
    version: 0,
};

function normalizeTime(value) {
    const n = Number(value);

    if (!Number.isFinite(n) || n < 0) {
        return 0;
    }

    return n;
}

async function fetchYoutubeTitle(videoId) {
    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const response = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
            { signal: AbortSignal.timeout(4000) }
        );

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        return typeof data.title === "string" ? data.title.trim().slice(0, 200) || null : null;
    } catch {
        return null;
    }
}

function getCurrentSnapshot(state) {
    if (!state) {
        return emptyState;
    }

    let normalizedState = {
        ...emptyState,
        ...state,
        mediaType: state.mediaType || MEDIA_YOUTUBE,
    };

    if (normalizedState.mediaType === MEDIA_MP3) {
        normalizedState = normalizePlaylistState(normalizedState);
    } else {
        const youtubeQueue = Array.isArray(normalizedState.youtubeQueue) && normalizedState.youtubeQueue.length
            ? normalizedState.youtubeQueue.filter((videoId) => /^[a-zA-Z0-9_-]{11}$/.test(videoId || ""))
            : (normalizedState.videoId ? [normalizedState.videoId] : []);
        const requestedIndex = Number(normalizedState.currentVideoIndex || 0);
        const currentIndex = youtubeQueue[requestedIndex] === normalizedState.videoId
            ? requestedIndex
            : youtubeQueue.indexOf(normalizedState.videoId);
        normalizedState = {
            ...normalizedState,
            youtubeQueue,
            currentVideoIndex: currentIndex >= 0 ? currentIndex : 0,
            youtubeTitles: normalizedState.youtubeTitles && typeof normalizedState.youtubeTitles === "object"
                ? normalizedState.youtubeTitles
                : {},
        };
    }

    if (!normalizedState.playing) {
        return normalizedState;
    }

    return {
        ...normalizedState,
        time: normalizedState.time + (Date.now() - normalizedState.updatedAt) / 1000,
        updatedAt: Date.now(),
    };
}

function hasLoadedMedia(state) {
    return state.mediaType === MEDIA_MP3 ? Boolean(state.audioId) : Boolean(state.videoId);
}

function normalizeMediaType(value) {
    return value === MEDIA_MP3 ? MEDIA_MP3 : MEDIA_YOUTUBE;
}

function makeTrackFromBody(body) {
    const audioId = String(body.audioId || "").trim();
    const audioName = String(body.audioName || "").trim();
    const audioUrl = String(body.audioUrl || "").trim();
    const audioSize = Number(body.audioSize || 0);

    if (!audioId || !audioName || !isValidAudioUrl(audioUrl) || !Number.isFinite(audioSize) || audioSize < 0) {
        return null;
    }

    return {
        audioId,
        audioName,
        audioSize,
        audioUrl,
    };
}

function isValidAudioUrl(audioUrl) {
    return String(audioUrl || "").startsWith("https://");
}

function getPlaylist(state) {
    if (Array.isArray(state.playlist) && state.playlist.length > 0) {
        return state.playlist.filter((track) => isValidAudioUrl(track?.audioUrl));
    }

    if (state.audioId && state.audioName && isValidAudioUrl(state.audioUrl)) {
        return [{
            audioId: state.audioId,
            audioName: state.audioName,
            audioSize: Number(state.audioSize || 0),
            audioUrl: state.audioUrl,
        }];
    }

    return [];
}

function getStoredPlaylist(state) {
    if (!Array.isArray(state.playlist)) {
        return [];
    }

    return state.playlist.filter((track) => (
        track?.audioId &&
        track?.audioName &&
        isValidAudioUrl(track?.audioUrl) &&
        Number.isFinite(Number(track.audioSize || 0))
    ));
}

function removeZeroSizeDuplicates(playlist) {
    const namesWithRealSize = new Set(
        playlist
            .filter((track) => Number(track.audioSize || 0) > 0)
            .map((track) => track.audioName)
    );

    return playlist.filter((track) => (
        Number(track.audioSize || 0) > 0 ||
        !namesWithRealSize.has(track.audioName)
    ));
}

function normalizePlaylistState(state) {
    const playlist = removeZeroSizeDuplicates(getPlaylist(state));
    const currentAudioId = state.audioId;
    const currentIndexByAudioId = playlist.findIndex((track) => track.audioId === currentAudioId);
    const requestedIndex = Number(state.currentTrackIndex || 0);
    const currentTrackIndex = currentIndexByAudioId >= 0
        ? currentIndexByAudioId
        : Math.min(Math.max(requestedIndex, 0), Math.max(playlist.length - 1, 0));

    return stateWithTrack(state, playlist, currentTrackIndex);
}

function stateWithTrack(state, playlist, currentTrackIndex, overrides = {}) {
    const track = playlist[currentTrackIndex] || null;

    return {
        ...state,
        mediaType: MEDIA_MP3,
        videoId: null,
        youtubeQueue: [],
        currentVideoIndex: 0,
        youtubeTitles: {},
        audioId: track?.audioId || null,
        audioName: track?.audioName || null,
        audioSize: track?.audioSize || 0,
        audioUrl: track?.audioUrl || null,
        playlist,
        currentTrackIndex,
        ...overrides,
    };
}

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
        },
    });
}

export async function GET() {
    const state = await redis.get(ROOM_KEY);
    return json(getCurrentSnapshot(state || emptyState));
}

export async function POST(request) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    const prev = await redis.get(ROOM_KEY);
    let next = getCurrentSnapshot(prev || emptyState);

    if (body.action === "load" && normalizeMediaType(body.mediaType) === MEDIA_YOUTUBE) {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(body.videoId || "")) {
            return json({ error: "Invalid YouTube video ID" }, 400);
        }

        next = {
            mediaType: MEDIA_YOUTUBE,
            videoId: body.videoId,
            youtubeQueue: [body.videoId],
            currentVideoIndex: 0,
            youtubeTitles: { [body.videoId]: await fetchYoutubeTitle(body.videoId) || body.videoId },
            audioId: null,
            audioName: null,
            audioSize: 0,
            audioUrl: null,
            playlist: [],
            currentTrackIndex: 0,
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (prev?.version || 0) + 1,
        };
    } else if (body.action === "appendYoutube") {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(body.videoId || "")) {
            return json({ error: "Invalid YouTube video ID" }, 400);
        }

        const youtubeQueue = Array.isArray(next.youtubeQueue) && next.youtubeQueue.length
            ? next.youtubeQueue
            : (next.videoId ? [next.videoId] : []);
        const title = await fetchYoutubeTitle(body.videoId);
        const firstVideo = youtubeQueue.length === 0;
        const updatedQueue = [...youtubeQueue, body.videoId];
        const currentVideoIndex = firstVideo ? 0 : Number(next.currentVideoIndex || 0);

        next = {
            ...next,
            mediaType: MEDIA_YOUTUBE,
            videoId: firstVideo ? body.videoId : next.videoId,
            youtubeQueue: updatedQueue,
            currentVideoIndex,
            youtubeTitles: {
                ...(next.youtubeTitles || {}),
                [body.videoId]: title || body.videoId,
            },
            playing: firstVideo ? false : Boolean(next.playing),
            time: firstVideo ? 0 : normalizeTime(next.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "appendYoutubeBatch") {
        const incomingIds = Array.isArray(body.videoIds)
            ? body.videoIds.filter((videoId) => /^[a-zA-Z0-9_-]{11}$/.test(videoId || "")).slice(0, 500)
            : [];

        if (incomingIds.length === 0) {
            return json({ error: "No valid YouTube videos were provided" }, 400);
        }

        const youtubeQueue = Array.isArray(next.youtubeQueue) && next.youtubeQueue.length
            ? next.youtubeQueue
            : (next.videoId ? [next.videoId] : []);
        const firstVideo = youtubeQueue.length === 0;
        const titles = body.titles && typeof body.titles === "object" ? body.titles : {};
        const youtubeTitles = { ...(next.youtubeTitles || {}) };

        for (const videoId of incomingIds) {
            youtubeTitles[videoId] = String(titles[videoId] || videoId).slice(0, 200);
        }

        next = {
            ...next,
            mediaType: MEDIA_YOUTUBE,
            videoId: firstVideo ? incomingIds[0] : next.videoId,
            youtubeQueue: [...youtubeQueue, ...incomingIds],
            currentVideoIndex: firstVideo ? 0 : Number(next.currentVideoIndex || 0),
            youtubeTitles,
            playing: firstVideo ? false : Boolean(next.playing),
            time: firstVideo ? 0 : normalizeTime(next.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "clearYoutubeQueue") {
        if (next.mediaType !== MEDIA_YOUTUBE) {
            return json({ error: "The YouTube queue is not active" }, 409);
        }

        next = {
            ...next,
            videoId: null,
            youtubeQueue: [],
            currentVideoIndex: 0,
            youtubeTitles: {},
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "advanceYoutube") {
        const youtubeQueue = Array.isArray(next.youtubeQueue) && next.youtubeQueue.length
            ? next.youtubeQueue
            : (next.videoId ? [next.videoId] : []);
        const currentVideoIndex = Number(next.currentVideoIndex || 0);
        const expectedIndex = Number(body.currentVideoIndex);
        const expectedVideoId = String(body.videoId || "");

        if (next.mediaType !== MEDIA_YOUTUBE || !next.videoId || youtubeQueue.length === 0) {
            return json({ error: "No YouTube queue loaded" }, 400);
        }

        if (!next.playing) {
            return json(next);
        }

        if (expectedVideoId !== next.videoId || expectedIndex !== currentVideoIndex) {
            return json(next);
        }

        if (currentVideoIndex + 1 >= youtubeQueue.length) {
            next = {
                ...next,
                playing: false,
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            };
        } else {
            const nextIndex = currentVideoIndex + 1;
            next = {
                ...next,
                videoId: youtubeQueue[nextIndex],
                currentVideoIndex: nextIndex,
                playing: true,
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            };
        }
    } else if (body.action === "selectYoutube") {
        const youtubeQueue = Array.isArray(next.youtubeQueue) && next.youtubeQueue.length
            ? next.youtubeQueue
            : (next.videoId ? [next.videoId] : []);
        const index = Number(body.index);

        if (!Number.isInteger(index) || index < 0 || index >= youtubeQueue.length) {
            return json({ error: "Invalid YouTube queue index" }, 400);
        }

        next = {
            ...next,
            mediaType: MEDIA_YOUTUBE,
            videoId: youtubeQueue[index],
            youtubeQueue,
            currentVideoIndex: index,
            playing: true,
            time: 0,
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "removeYoutube") {
        const youtubeQueue = Array.isArray(next.youtubeQueue) && next.youtubeQueue.length
            ? [...next.youtubeQueue]
            : (next.videoId ? [next.videoId] : []);
        const index = Number(body.index);

        if (!Number.isInteger(index) || index < 0 || index >= youtubeQueue.length) {
            return json({ error: "Invalid YouTube queue index" }, 400);
        }

        const currentIndex = Number(next.currentVideoIndex || 0);
        const removingCurrent = index === currentIndex;
        youtubeQueue.splice(index, 1);

        if (youtubeQueue.length === 0) {
            next = {
                ...next,
                videoId: null,
                youtubeQueue: [],
                currentVideoIndex: 0,
                playing: false,
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            };
        } else if (removingCurrent) {
            const nextIndex = Math.min(index, youtubeQueue.length - 1);
            next = {
                ...next,
                videoId: youtubeQueue[nextIndex],
                youtubeQueue,
                currentVideoIndex: nextIndex,
                playing: Boolean(next.playing),
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            };
        } else {
            next = {
                ...next,
                youtubeQueue,
                currentVideoIndex: currentIndex > index ? currentIndex - 1 : currentIndex,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            };
        }

    } else if (body.action === "load" && normalizeMediaType(body.mediaType) === MEDIA_MP3) {
        const track = makeTrackFromBody(body);

        if (!track) {
            return json({ error: "Invalid MP3 metadata" }, 400);
        }

        next = stateWithTrack(next, [track], 0, {
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (prev?.version || 0) + 1,
        });
    } else if (body.action === "appendMp3") {
        const track = makeTrackFromBody(body);

        if (!track) {
            return json({ error: "Invalid MP3 metadata" }, 400);
        }

        const playlist = getStoredPlaylist(next);
        const nextPlaylist = [...playlist, track];
        const currentTrackIndex = next.mediaType === MEDIA_MP3 && next.audioId
            ? Math.max(0, Number(next.currentTrackIndex || 0))
            : nextPlaylist.length - 1;

        next = stateWithTrack(next, nextPlaylist, currentTrackIndex, {
            playing: next.mediaType === MEDIA_MP3 ? Boolean(next.playing) : false,
            time: next.mediaType === MEDIA_MP3 ? normalizeTime(next.time) : 0,
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        });
    } else if (body.action === "selectTrack") {
        const playlist = getPlaylist(next);
        const index = Number(body.index);

        if (!Number.isInteger(index) || index < 0 || index >= playlist.length) {
            return json({ error: "Invalid track index" }, 400);
        }

        next = stateWithTrack(next, playlist, index, {
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        });
    } else if (body.action === "advanceTrack") {
        const playlist = getPlaylist(next);
        const currentTrackIndex = Number(next.currentTrackIndex || 0);
        const nextTrackIndex = currentTrackIndex + 1;
        const expectedVersion = Number(body.version);
        const expectedTrackIndex = Number(body.currentTrackIndex);
        const expectedAudioId = String(body.audioId || "");

        if (next.mediaType !== MEDIA_MP3 || playlist.length === 0) {
            return json({ error: "No MP3 playlist loaded" }, 400);
        }

        if (
            Number.isFinite(expectedVersion) &&
            Number.isFinite(next.version) &&
            expectedVersion !== next.version
        ) {
            return json(next);
        }

        if (
            expectedAudioId &&
            expectedAudioId !== next.audioId
        ) {
            return json(next);
        }

        if (
            Number.isInteger(expectedTrackIndex) &&
            expectedTrackIndex !== currentTrackIndex
        ) {
            return json(next);
        }

        if (nextTrackIndex >= playlist.length) {
            next = stateWithTrack(next, playlist, currentTrackIndex, {
                playing: false,
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            });
        } else {
            next = stateWithTrack(next, playlist, nextTrackIndex, {
                playing: true,
                time: 0,
                updatedAt: Date.now(),
                version: (next.version || 0) + 1,
            });
        }
    } else if (body.action === "removeTrack") {
        const playlist = getPlaylist(next);
        const index = Number(body.index);

        if (!Number.isInteger(index) || index < 0 || index >= playlist.length) {
            return json({ error: "Invalid track index" }, 400);
        }

        const previousTrackIndex = Number(next.currentTrackIndex || 0);
        const removedCurrentTrack = index === previousTrackIndex;
        const [removedTrack] = playlist.splice(index, 1);
        await deleteMp3Blob(removedTrack.audioUrl);

        const nextIndex = playlist.length === 0
            ? 0
            : Math.min(index < previousTrackIndex ? previousTrackIndex - 1 : previousTrackIndex, playlist.length - 1);

        next = stateWithTrack(next, playlist, nextIndex, {
            playing: removedCurrentTrack ? false : Boolean(next.playing),
            time: removedCurrentTrack ? 0 : normalizeTime(next.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        });
    } else if (body.action === "clearPlaylist") {
        const version = (next.version || 0) + 1;
        await deletePlaylistBlobs(next);

        if (next.mediaType === MEDIA_MP3) {
            next = stateWithTrack(next, [], 0, {
                playing: false,
                time: 0,
                updatedAt: Date.now(),
                version,
            });
        } else {
            next = {
                ...next,
                audioId: null,
                audioName: null,
                audioSize: 0,
                audioUrl: null,
                playlist: [],
                currentTrackIndex: 0,
                updatedAt: Date.now(),
                version,
            };
        }
    } else if (body.action === "play") {
        if (!hasLoadedMedia(next)) {
            return json({ error: "No media loaded" }, 400);
        }

        next = {
            ...next,
            playing: true,
            time: normalizeTime(body.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "pause") {
        if (!hasLoadedMedia(next)) {
            return json({ error: "No media loaded" }, 400);
        }

        next = {
            ...next,
            playing: false,
            time: normalizeTime(body.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "seek") {
        if (!hasLoadedMedia(next)) {
            return json({ error: "No media loaded" }, 400);
        }

        next = {
            ...next,
            time: normalizeTime(body.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else {
        return json({ error: "Unknown action" }, 400);
    }

    await redis.set(ROOM_KEY, next);

    return json(next);
}
