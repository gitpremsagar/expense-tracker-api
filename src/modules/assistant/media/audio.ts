import { spawn } from "node:child_process";
import { AppError } from "../../../utils/errors.js";
import { transcribeAudio } from "../../../lib/deepseek.js";
import { sanitizeFilename } from "./image.js";

export type ValidatedAudio = {
  mimeType: string;
  filename: string;
  durationMs: number | null;
};

function wavDurationMs(buffer: Buffer): number | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  const byteRate = buffer.readUInt32LE(28);
  const dataSize = buffer.readUInt32LE(40);
  if (!byteRate || !dataSize) return null;

  return Math.round((dataSize / byteRate) * 1000);
}

type AudioKind = "wav" | "ogg" | "other" | null;

function detectAudioKind(buffer: Buffer, filename: string): AudioKind {
  if (buffer.length >= 12) {
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
      return "wav";
    }
    if (buffer.toString("ascii", 0, 4) === "OggS") return "ogg";
    if (buffer.toString("ascii", 4, 8) === "ftyp") return "other";
    if (
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    ) {
      return "other";
    }
  }

  if (/\.(m4a|mp4|aac|webm|3gp|amr|caf)$/i.test(filename)) return "other";
  return null;
}

/**
 * Mobile recorders produce AAC/M4A or WebM, which DeepSeek ASR does not accept
 * (it takes 16-bit PCM WAV or Ogg Opus only). Convert those to mono 16 kHz WAV.
 */
async function transcodeToWav(buffer: Buffer): Promise<Buffer> {
  const ffmpegPath = (await import("ffmpeg-static")).default;
  if (!ffmpegPath) {
    throw new AppError(
      503,
      "Voice notes in this format need the server audio transcoder, which is not installed.",
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-acodec",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      { windowsHide: true },
    );

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (error: AppError | null, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output ?? Buffer.concat(chunks));
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AppError(504, "Converting that voice note took too long. Try a shorter clip."));
    }, 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 20 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new AppError(413, "That voice note is too long. Keep it under 2 minutes."));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", () => {
      // ffmpeg diagnostics are noisy and not useful to users.
    });

    child.on("error", () => {
      finish(new AppError(503, "Could not convert that voice note. Please try again."));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        finish(new AppError(422, "That audio format could not be read. Please re-record the note."));
        return;
      }
      finish(null);
    });

    child.stdin.write(buffer);
    child.stdin.end();
  });
}

export function validateAudio(buffer: Buffer, originalName?: string): ValidatedAudio {
  if (buffer.length < 44) {
    throw new AppError(422, "That recording is empty. Please try again.");
  }

  const kind = detectAudioKind(buffer, originalName ?? "");
  if (kind !== "wav" && kind !== "ogg") {
    throw new AppError(415, "Please record the note in WAV or Ogg Opus format.");
  }

  const durationMs = kind === "wav" ? wavDurationMs(buffer) : null;
  if (durationMs !== null && durationMs > 120_000) {
    throw new AppError(422, "Keep voice notes under 2 minutes.");
  }

  return {
    mimeType: kind === "wav" ? "audio/wav" : "audio/ogg",
    filename: sanitizeFilename(originalName, kind === "wav" ? "note.wav" : "note.ogg"),
    durationMs,
  };
}

export async function transcribeVoiceNote(
  buffer: Buffer,
  originalName?: string,
): Promise<{ text: string; durationMs: number | null }> {
  const kind = detectAudioKind(buffer, originalName ?? "");
  if (!kind) {
    throw new AppError(415, "That file is not a voice recording we can read.");
  }

  const wav = kind === "other" ? await transcodeToWav(buffer) : buffer;
  const audio = validateAudio(wav, kind === "other" ? "note.wav" : originalName);
  const result = await transcribeAudio(wav, audio.filename, audio.mimeType);

  return {
    text: result.text,
    durationMs: result.durationMs ?? audio.durationMs,
  };
}
