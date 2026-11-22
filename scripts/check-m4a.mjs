import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

const BASE = process.env.API_URL ?? "http://localhost:3711";
const PASSWORD = "TestPass123!";
const EMAIL = `assistant-m4a-${Date.now()}@example.com`;

function makeWav(seconds = 1, sampleRate = 16000) {
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), 44 + i * 2);
  }
  return buffer;
}

async function request(path, options = {}, token) {
  const headers = new Headers(options.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    ...(options.body && !(options.body instanceof FormData) ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const wav = makeWav();
  const dir = mkdtempSync(join(tmpdir(), "m4a-check-"));
  const wavPath = join(dir, "note.wav");
  const m4aPath = join(dir, "note.m4a");
  writeFileSync(wavPath, wav);
  const conversion = spawnSync(
    ffmpegPath,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-c:a", "aac", "-b:a", "64k", m4aPath],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  if (conversion.status !== 0) throw new Error(conversion.stderr.toString());
  const m4a = readFileSync(m4aPath);
  rmSync(dir, { recursive: true, force: true });

  const signup = await request("/auth/signup", {
    method: "POST",
    body: { name: "M4A Test", email: EMAIL, password: PASSWORD },
  });
  const token = signup.accessToken;
  await request("/assistant/consent", { method: "POST" }, token);
  const thread = await request("/assistant/threads", { method: "POST", body: {} }, token);

  const form = new FormData();
  form.append("kind", "AUDIO");
  form.append("file", new Blob([m4a], { type: "audio/m4a" }), "voice-note.m4a");
  const result = await request(`/assistant/threads/${thread.thread.id}/attachments`, {
    method: "POST",
    body: form,
  }, token);

  console.log("Transcript:", result.transcript);
  if (!/lunch/i.test(result.transcript)) throw new Error("Unexpected transcript");

  await request("/auth/me", { method: "DELETE", body: { password: PASSWORD } }, token);
  console.log("M4A transcode + ASR OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
