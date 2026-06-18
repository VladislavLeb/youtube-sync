import { AccessToken } from "livekit-server-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIVEKIT_ROOM = "youtube-sync-live";

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
        },
    });
}

export async function POST(request) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !livekitUrl) {
        return json({ error: "LiveKit environment variables are not configured" }, 500);
    }

    const role = body.role === "dj" ? "dj" : "listener";
    const identity = String(body.identity || `${role}-${crypto.randomUUID()}`).slice(0, 80);

    const token = new AccessToken(apiKey, apiSecret, {
        identity,
        name: identity,
        ttl: "2h",
    });

    token.addGrant({
        room: LIVEKIT_ROOM,
        roomJoin: true,
        canPublish: role === "dj",
        canPublishData: role === "dj",
        canSubscribe: true,
    });

    return json({
        livekitUrl,
        room: LIVEKIT_ROOM,
        token: await token.toJwt(),
    });
}
