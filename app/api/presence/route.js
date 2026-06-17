import { Redis } from "@upstash/redis";
import {
    clearMp3BlobsIfRoomIsEmpty,
    CLIENT_KEY_PREFIX,
} from "../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();
const CLIENT_TTL_SECONDS = 90;
const ROOM_KEY = "youtube-sync:main";

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
        },
    });
}

function normalizeClientId(value) {
    const clientId = String(value || "").trim();

    if (!/^[a-f0-9-]{36}$/.test(clientId)) {
        return null;
    }

    return clientId;
}

export async function POST(request) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    const clientId = normalizeClientId(body.clientId);

    if (!clientId) {
        return json({ error: "Invalid client ID" }, 400);
    }

    const clientKey = `${CLIENT_KEY_PREFIX}${clientId}`;

    if (body.action === "leave") {
        await redis.del(clientKey);
        const cleared = await clearMp3BlobsIfRoomIsEmpty(redis, ROOM_KEY);

        if (cleared) {
            const prev = await redis.get(ROOM_KEY);

            await redis.set(ROOM_KEY, {
                mediaType: "youtube",
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
                version: (prev?.version || 0) + 1,
            });
        }

        return json({
            cleared,
            ok: true,
        });
    }

    await redis.set(clientKey, Date.now(), {
        ex: CLIENT_TTL_SECONDS,
    });

    return json({
        ok: true,
    });
}
