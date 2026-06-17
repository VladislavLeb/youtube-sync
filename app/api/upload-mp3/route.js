import { Redis } from "@upstash/redis";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
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

function sanitizeFileName(fileName) {
    return String(fileName || "audio.mp3")
        .replace(/[/\\?%*:|"<>]/g, "-")
        .replace(/\s+/g, " ")
        .trim() || "audio.mp3";
}

export async function POST(request) {
    let formData;

    try {
        formData = await request.formData();
    } catch {
        return json({ error: "Invalid form data" }, 400);
    }

    const file = formData.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
        return json({ error: "MP3 file is required" }, 400);
    }

    if (file.size > MAX_MP3_BYTES) {
        return json({ error: "MP3 file is too large. Max size is 50 MB." }, 413);
    }

    const fileName = sanitizeFileName(file.name || "audio.mp3");
    const fileType = String(file.type || "");

    if (fileType && fileType !== "audio/mpeg" && !fileName.toLowerCase().endsWith(".mp3")) {
        return json({ error: "Only MP3 files are supported" }, 400);
    }

    const state = await redis.get(ROOM_KEY);
    const uploadedBytes = getPlaylistBytes(state);

    if (uploadedBytes + file.size > MAX_TOTAL_MP3_BYTES) {
        return json({
            error: "MP3 storage limit exceeded. Delete songs from the playlist before uploading more.",
            limitBytes: MAX_TOTAL_MP3_BYTES,
            usedBytes: uploadedBytes,
        }, 413);
    }

    const audioId = randomUUID();
    const blob = await put(`mp3/${audioId}-${fileName}`, file, {
        access: "public",
        contentType: "audio/mpeg",
    });

    return json({
        audioId,
        audioName: fileName,
        audioSize: file.size,
        audioUrl: blob.url,
    });
}
