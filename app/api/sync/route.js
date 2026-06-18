import { Redis } from "@upstash/redis";
import { deleteMp3Blob } from "../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();

const ROOM_KEY = "youtube-sync:main";
const MEDIA_YOUTUBE = "youtube";
const MEDIA_MP3 = "mp3";

const emptyState = {
    mediaType: MEDIA_YOUTUBE,
    videoId: null,
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

        if (next.mediaType !== MEDIA_MP3 || playlist.length === 0) {
            return json({ error: "No MP3 playlist loaded" }, 400);
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
