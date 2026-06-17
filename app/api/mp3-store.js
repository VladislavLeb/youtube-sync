import { del } from "@vercel/blob";

export const MAX_MP3_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_MP3_BYTES = 500 * 1024 * 1024;
export const CLIENT_KEY_PREFIX = "youtube-sync:clients:";

export function isValidAudioId(value) {
    return /^[a-f0-9-]{36}$/.test(value || "");
}

export function getPlaylistBytes(state) {
    if (!Array.isArray(state?.playlist)) {
        return Number(state?.audioSize || 0);
    }

    return state.playlist.reduce((total, track) => (
        total + Number(track?.audioSize || 0)
    ), 0);
}

export async function listClientKeys(redis) {
    return redis.keys(`${CLIENT_KEY_PREFIX}*`);
}

export async function deleteMp3Blob(audioUrl) {
    if (!audioUrl || !String(audioUrl).startsWith("http")) {
        return false;
    }

    await del(audioUrl);
    return true;
}

export async function deletePlaylistBlobs(state) {
    const playlist = Array.isArray(state?.playlist) ? state.playlist : [];
    const urls = playlist
        .map((track) => track?.audioUrl)
        .filter((audioUrl) => audioUrl && String(audioUrl).startsWith("http"));

    if (urls.length === 0 && state?.audioUrl && String(state.audioUrl).startsWith("http")) {
        urls.push(state.audioUrl);
    }

    if (urls.length === 0) {
        return 0;
    }

    await del(urls);
    return urls.length;
}

export async function clearMp3BlobsIfRoomIsEmpty(redis, roomKey) {
    const clientKeys = await listClientKeys(redis);

    if (clientKeys.length > 0) {
        return false;
    }

    const state = await redis.get(roomKey);
    await deletePlaylistBlobs(state);

    return true;
}
