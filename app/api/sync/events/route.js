import { Redis } from "@upstash/redis";
import { subscribeToSyncEvents } from "../../sync-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redis = Redis.fromEnv();
const ROOM_KEY = "youtube-sync:main";

function getCurrentSnapshot(state) {
    if (!state) {
        return state;
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

export async function GET(request) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const unsubscribe = subscribeToSyncEvents(controller);
            const state = await redis.get(ROOM_KEY);

            if (state) {
                controller.enqueue(
                    encoder.encode(`event: sync\ndata: ${JSON.stringify(getCurrentSnapshot(state))}\n\n`)
                );
            }

            const keepAliveId = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(": keep-alive\n\n"));
                } catch {
                    clearInterval(keepAliveId);
                    unsubscribe();
                }
            }, 25000);

            request.signal.addEventListener("abort", () => {
                clearInterval(keepAliveId);
                unsubscribe();
                controller.close();
            });
        },
    });

    return new Response(stream, {
        headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
        },
    });
}
