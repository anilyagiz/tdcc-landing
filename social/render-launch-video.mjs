// Renders social/launch-video.html frame by frame and muxes it with the
// soundtrack from social/launch-audio.mjs. Needs playwright and ffmpeg.
//
//   node social/render-launch-video.mjs out.mp4 [--fps 60] [--audio audio.wav]
//   node social/render-launch-video.mjs --stills 2,9,13,17 outdir   (PNG frames to check)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const fps = Number(opt("--fps", 60));
const audio = opt("--audio", null);
const stills = opt("--stills", null);
const out = args[0] || "launch-video.mp4";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto("file://" + path.join(here, "launch-video.html"));
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.fonts].filter((f) => f.status === "loaded").length >= 6);
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  mkdirSync(out, { recursive: true });
  for (const t of stills.split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({ path: path.join(out, `t${String(t).padStart(5, "0")}.png`) });
  }
  await browser.close();
  console.log(`wrote ${stills.split(",").length} stills to ${out}`);
  process.exit(0);
}

const ff = spawn("ffmpeg", [
  "-y", "-v", "error",
  "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  ...(audio ? ["-i", audio] : []),
  "-map", "0:v", ...(audio ? ["-map", "1:a", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
  "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high", "-tune", "film",
  "-movflags", "+faststart", "-shortest", out,
], { stdio: ["pipe", "inherit", "inherit"] });

const frames = Math.round(duration * fps);
const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / fps);
  const buf = await page.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % (fps * 5) === 0) console.log(`frame ${i}/${frames} (${Math.round((Date.now() - started) / 1000)} s)`);
}
ff.stdin.end();
await new Promise((r, j) => ff.on("close", (c) => (c ? j(new Error("ffmpeg " + c)) : r())));
await browser.close();
console.log(`wrote ${out}: ${frames} frames at ${fps} fps in ${Math.round((Date.now() - started) / 1000)} s`);
