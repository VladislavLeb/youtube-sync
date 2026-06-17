import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();

const ROOM_KEY = "youtube-sync:main";

const emptyState = {
    videoId: null,
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

    if (!state.playing) {
        return state;
    }

    return {
        ...state,
        time: state.time + (Date.now() - state.updatedAt) / 1000,
        updatedAt: Date.now(),
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
    let next = prev || emptyState;

    if (body.action === "load") {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(body.videoId || "")) {
            return json({ error: "Invalid YouTube video ID" }, 400);
        }

        next = {
            videoId: body.videoId,
            playing: false,
            time: 0,
            updatedAt: Date.now(),
            version: (prev?.version || 0) + 1,
        };
    } else if (body.action === "play") {
        if (!next.videoId) {
            return json({ error: "No video loaded" }, 400);
        }

        next = {
            ...next,
            playing: true,
            time: normalizeTime(body.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "pause") {
        if (!next.videoId) {
            return json({ error: "No video loaded" }, 400);
        }

        next = {
            ...next,
            playing: false,
            time: normalizeTime(body.time),
            updatedAt: Date.now(),
            version: (next.version || 0) + 1,
        };
    } else if (body.action === "seek") {
        if (!next.videoId) {
            return json({ error: "No video loaded" }, 400);
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