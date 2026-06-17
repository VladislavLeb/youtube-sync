import { Redis } from "@upstash/redis";

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
    audioUrl: null,
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

    const normalizedState = {
        ...emptyState,
        ...state,
        mediaType: state.mediaType || MEDIA_YOUTUBE,
    };

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
    let next = prev || emptyState;

    if (body.action === "load" && normalizeMediaType(body.mediaType) === MEDIA_YOUTUBE) {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(body.videoId || "")) {
            return json({ error: "Invalid YouTube video ID" }, 400);
        }

        next = {
            mediaType: MEDIA_YOUTUBE,
            videoId: body.videoId,
            audioId: null,
            audioName: null,
            audioUrl: null,
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (prev?.version || 0) + 1,
        };
    } else if (body.action === "load" && normalizeMediaType(body.mediaType) === MEDIA_MP3) {
        const audioId = String(body.audioId || "").trim();
        const audioName = String(body.audioName || "").trim();
        const audioUrl = String(body.audioUrl || "").trim();

        if (!audioId || !audioName || !audioUrl) {
            return json({ error: "Invalid MP3 metadata" }, 400);
        }

        next = {
            mediaType: MEDIA_MP3,
            videoId: null,
            audioId,
            audioName,
            audioUrl,
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (prev?.version || 0) + 1,
        };
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
