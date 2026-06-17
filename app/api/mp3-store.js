import { mkdir, readdir, rm } from "fs/promises";
import path from "path";

export const MP3_TEMP_DIR = path.join("/tmp", "youtube-sync-mp3");
export const MAX_MP3_BYTES = 50 * 1024 * 1024;
export const CLIENT_KEY_PREFIX = "youtube-sync:clients:";

export function isValidAudioId(value) {
    return /^[a-f0-9-]{36}$/.test(value || "");
}

export function getMp3Path(audioId) {
    if (!isValidAudioId(audioId)) {
        return null;
    }

    return path.join(MP3_TEMP_DIR, `${audioId}.mp3`);
}

export async function ensureMp3TempDir() {
    await mkdir(MP3_TEMP_DIR, {
        recursive: true,
    });
}

export async function clearMp3TempDir() {
    await rm(MP3_TEMP_DIR, {
        force: true,
        recursive: true,
    });
}

export async function listClientKeys(redis) {
    return redis.keys(`${CLIENT_KEY_PREFIX}*`);
}

export async function clearMp3TempDirIfRoomIsEmpty(redis) {
    const clientKeys = await listClientKeys(redis);

    if (clientKeys.length > 0) {
        return false;
    }

    await clearMp3TempDir();
    return true;
}

export async function listUploadedMp3Files() {
    try {
        return await readdir(MP3_TEMP_DIR);
    } catch {
        return [];
    }
}
