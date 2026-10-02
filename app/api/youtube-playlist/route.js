export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const MAX_PLAYLIST_VIDEOS = 500;
const YOUTUBE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
};

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
}

function parseEmbeddedJson(source, marker, fromIndex = 0) {
    const match = marker.exec(source.slice(fromIndex));
    const markerIndex = match ? fromIndex + match.index : -1;

    if (markerIndex < 0) return null;

    const start = source.indexOf("{", markerIndex);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
        const char = source[index];

        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(source.slice(start, index + 1));
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

function parseYouTubeConfig(source) {
    const config = {};
    const marker = /ytcfg\.set\(/g;
    let match;

    while ((match = marker.exec(source))) {
        Object.assign(config, parseEmbeddedJson(source, /ytcfg\.set\(/, match.index) || {});
    }

    return config;
}

function collectVideosAndContinuation(data) {
    const videos = [];
    let continuation = null;
    const seen = new Set();
    const stack = [data];

    while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;

        if (Array.isArray(value)) {
            for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
            continue;
        }

        const renderer = value.playlistVideoRenderer || value.playlistPanelVideoRenderer;
        const lockup = value.lockupViewModel;
        if (renderer || lockup) {
            const videoId = renderer?.videoId || lockup?.contentId;
            const title = renderer?.title?.runs?.map((run) => run.text).join("") ||
                renderer?.title?.simpleText ||
                lockup?.metadata?.lockupMetadataViewModel?.title?.content;

            if (YOUTUBE_ID_PATTERN.test(videoId || "") && !seen.has(videoId)) {
                seen.add(videoId);
                videos.push({ videoId, title: String(title || videoId).slice(0, 200) });
            }
        }

        const itemContinuation = value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        const dataContinuation = value.nextContinuationData?.continuation;
        const commandContinuation = value.continuationCommand?.token;
        if (!continuation && (itemContinuation || dataContinuation || commandContinuation)) {
            continuation = itemContinuation || dataContinuation || commandContinuation;
        }

        for (const child of Object.values(value)) stack.push(child);
    }

    return { videos, continuation };
}

function playlistIdFromRequest(request) {
    const url = new URL(request.url);
    const playlistId = url.searchParams.get("list") || "";
    return /^[a-zA-Z0-9_-]{10,100}$/.test(playlistId) ? playlistId : null;
}

export async function GET(request) {
    const playlistId = playlistIdFromRequest(request);

    if (!playlistId) {
        return json({ error: "Could not recognize the YouTube playlist link." }, 400);
    }

    try {
        const playlistUrl = new URL("https://www.youtube.com/playlist");
        playlistUrl.searchParams.set("list", playlistId);
        const pageResponse = await fetch(playlistUrl, {
            headers: YOUTUBE_HEADERS,
            signal: AbortSignal.timeout(12000),
        });

        if (!pageResponse.ok) {
            return json({ error: "YouTube could not open this playlist. Check that it is public or unlisted." }, 422);
        }

        const page = await pageResponse.text();
        const config = parseYouTubeConfig(page);
        const initialData = parseEmbeddedJson(page, /ytInitialData\s*=/);

        if (!initialData) {
            return json({ error: "YouTube did not return playlist data. Try again in a moment." }, 502);
        }

        const videos = [];
        let { videos: pageVideos, continuation } = collectVideosAndContinuation(initialData);
        videos.push(...pageVideos);

        const apiKey = config?.INNERTUBE_API_KEY;
        const context = config?.INNERTUBE_CONTEXT;
        let pageCount = 0;

        while (continuation && videos.length < MAX_PLAYLIST_VIDEOS && apiKey && context && pageCount < 10) {
            pageCount += 1;
            const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}`, {
                method: "POST",
                headers: {
                    ...YOUTUBE_HEADERS,
                    "Content-Type": "application/json",
                    "X-YouTube-Client-Name": String(config.INNERTUBE_CLIENT_NAME || 1),
                    "X-YouTube-Client-Version": String(config.INNERTUBE_CLIENT_VERSION || "2.20250101.00.00"),
                },
                body: JSON.stringify({ context, continuation }),
                signal: AbortSignal.timeout(12000),
            });

            if (!response.ok) break;

            const data = await response.json();
            const page = collectVideosAndContinuation(data);
            videos.push(...page.videos);
            continuation = page.continuation;
        }

        const uniqueVideos = [];
        const seen = new Set();
        for (const video of videos) {
            if (!seen.has(video.videoId)) {
                seen.add(video.videoId);
                uniqueVideos.push(video);
            }
            if (uniqueVideos.length >= MAX_PLAYLIST_VIDEOS) break;
        }

        if (!uniqueVideos.length) {
            return json({ error: "No playable videos were found in this playlist." }, 422);
        }

        return json({
            videos: uniqueVideos,
            truncated: Boolean(continuation) || uniqueVideos.length >= MAX_PLAYLIST_VIDEOS,
        });
    } catch (error) {
        console.error("Could not load YouTube playlist", error);
        return json({ error: "Could not load the YouTube playlist. Please try again." }, 502);
    }
}
