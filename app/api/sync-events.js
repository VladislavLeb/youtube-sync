const globalForSyncEvents = globalThis;

if (!globalForSyncEvents.youtubeSyncClients) {
    globalForSyncEvents.youtubeSyncClients = new Set();
}

export function subscribeToSyncEvents(controller) {
    globalForSyncEvents.youtubeSyncClients.add(controller);

    return () => {
        globalForSyncEvents.youtubeSyncClients.delete(controller);
    };
}

export function publishSyncState(state) {
    const message = `event: sync\ndata: ${JSON.stringify(state)}\n\n`;
    const encoder = new TextEncoder();
    const chunk = encoder.encode(message);

    for (const controller of globalForSyncEvents.youtubeSyncClients) {
        try {
            controller.enqueue(chunk);
        } catch {
            globalForSyncEvents.youtubeSyncClients.delete(controller);
        }
    }
}
