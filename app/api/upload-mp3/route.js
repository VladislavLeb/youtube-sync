import { Redis } from "@upstash/redis";
import { handleUpload } from "@vercel/blob/client";
import {
    getPlaylistBytes,
    MAX_MP3_BYTES,
    MAX_TOTAL_MP3_BYTES,
} from "../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();
const ROOM_KEY = "youtube-sync:main";

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
        },
    });
}

function parseClientPayload(clientPayload) {
    try {
        return JSON.parse(clientPayload || "{}");
    } catch {
        return {};
    }
}

async function validateUpload(fileSize, pathname = "mp3/audio.mp3") {
    if (!pathname.startsWith("mp3/") || !pathname.toLowerCase().endsWith(".mp3")) {
        throw new Error("Only MP3 files are supported");
    }

    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        throw new Error("Invalid MP3 file size");
    }

    if (fileSize > MAX_MP3_BYTES) {
        throw new Error("MP3 file is too large. Max size is 50 MB.");
    }

    const state = await redis.get(ROOM_KEY);
    const uploadedBytes = getPlaylistBytes(state);

    if (uploadedBytes + fileSize > MAX_TOTAL_MP3_BYTES) {
        throw new Error(
            "MP3 storage limit exceeded. Delete songs from the playlist before uploading more."
        );
    }

    return {
        maximumSizeInBytes: Math.min(
            MAX_MP3_BYTES,
            MAX_TOTAL_MP3_BYTES - uploadedBytes
        ),
        uploadedBytes,
    };
}

export async function POST(request) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    if (body.action === "validate") {
        try {
            const result = await validateUpload(Number(body.size || 0));
            return json({
                ok: true,
                ...result,
            });
        } catch (error) {
            return json({ error: error.message || "MP3 upload failed" }, 400);
        }
    }

    try {
        const response = await handleUpload({
            body,
            request,
            onBeforeGenerateToken: async (pathname, clientPayload) => {
                const payload = parseClientPayload(clientPayload);
                const fileSize = Number(payload.size || 0);
                const { maximumSizeInBytes } = await validateUpload(fileSize, pathname);

                return {
                    addRandomSuffix: false,
                    allowedContentTypes: ["audio/mpeg"],
                    maximumSizeInBytes,
                    tokenPayload: JSON.stringify({
                        size: fileSize,
                    }),
                };
            },
        });

        return json(response);
    } catch (error) {
        return json({ error: error.message || "MP3 upload failed" }, 400);
    }
}
