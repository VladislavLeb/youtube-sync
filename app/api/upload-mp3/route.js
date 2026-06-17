import { writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import {
    ensureMp3TempDir,
    getMp3Path,
    MAX_MP3_BYTES,
} from "../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
        },
    });
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

    const fileName = String(file.name || "audio.mp3");
    const fileType = String(file.type || "");

    if (fileType && fileType !== "audio/mpeg" && !fileName.toLowerCase().endsWith(".mp3")) {
        return json({ error: "Only MP3 files are supported" }, 400);
    }

    const audioId = randomUUID();
    const filePath = getMp3Path(audioId);
    const buffer = Buffer.from(await file.arrayBuffer());

    await ensureMp3TempDir();
    await writeFile(filePath, buffer);

    return json({
        audioId,
        audioName: fileName,
        audioUrl: `/api/mp3/${audioId}`,
    });
}
