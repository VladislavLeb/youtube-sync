import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { getMp3Path } from "../../mp3-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function makeHeaders(extraHeaders = {}) {
    return {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Content-Type": "audio/mpeg",
        ...extraHeaders,
    };
}

function parseRange(rangeHeader, fileSize) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");

    if (!match) {
        return null;
    }

    const startText = match[1];
    const endText = match[2];

    if (!startText && !endText) {
        return null;
    }

    if (!startText) {
        const suffixLength = Number(endText);

        if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
            return null;
        }

        return {
            start: Math.max(fileSize - suffixLength, 0),
            end: fileSize - 1,
        };
    }

    const start = Number(startText);
    const end = endText ? Number(endText) : fileSize - 1;

    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        start >= fileSize
    ) {
        return null;
    }

    return {
        start,
        end: Math.min(end, fileSize - 1),
    };
}

export async function GET(request, { params }) {
    const { audioId } = await params;
    const filePath = getMp3Path(audioId);

    if (!filePath) {
        return Response.json({ error: "Invalid MP3 ID" }, { status: 400 });
    }

    try {
        const fileStat = await stat(filePath);
        const fileSize = fileStat.size;
        const range = parseRange(request.headers.get("range"), fileSize);

        if (request.headers.get("range") && !range) {
            return new Response(null, {
                status: 416,
                headers: makeHeaders({
                    "Content-Range": `bytes */${fileSize}`,
                }),
            });
        }

        if (range) {
            const stream = createReadStream(filePath, {
                start: range.start,
                end: range.end,
            });
            const contentLength = range.end - range.start + 1;

            return new Response(Readable.toWeb(stream), {
                status: 206,
                headers: makeHeaders({
                    "Content-Length": String(contentLength),
                    "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
                }),
            });
        }

        const stream = createReadStream(filePath);

        return new Response(Readable.toWeb(stream), {
            headers: makeHeaders({
                "Content-Length": String(fileSize),
            }),
        });
    } catch {
        return Response.json({ error: "MP3 file not found" }, { status: 404 });
    }
}
