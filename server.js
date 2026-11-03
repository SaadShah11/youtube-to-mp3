const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const MAX_CONCURRENT = 2;
const JOB_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();
let activeJobs = 0;

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

function isYouTubeUrl(raw) {
  if (typeof raw !== "string") return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") return url.pathname.length > 1;
  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    if (url.pathname === "/watch" && url.searchParams.has("v")) return true;
    if (url.pathname.startsWith("/shorts/")) return true;
    if (url.pathname.startsWith("/embed/")) return true;
    if (url.pathname.startsWith("/live/")) return true;
  }
  return false;
}

function sanitizeFilename(name) {
  const cleaned = String(name || "audio")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "audio";
}

function humanError(err) {
  const message = String(err?.message || err || "Conversion failed.");
  if (err?.code === "MISSING_YTDLP" || /ENOENT|not found/i.test(message)) {
    return "yt-dlp was not found. Install yt-dlp and ffmpeg, then restart the server.";
  }
  if (/ffmpeg/i.test(message)) {
    return "ffmpeg is required for MP3 conversion. Install ffmpeg and ensure it is on your PATH.";
  }
  if (/private|members-only|sign in|login/i.test(message)) {
    return "This video is private or requires sign-in.";
  }
  if (/unavailable|not available|removed/i.test(message)) {
    return "This video is unavailable.";
  }
  const firstLine = message.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim().slice(0, 400) || "Conversion failed.";
}

async function ensureDownloadsDir() {
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });
}

async function cleanupJobFiles(jobId) {
  try {
    const entries = await fsp.readdir(DOWNLOADS_DIR);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(jobId))
        .map((name) =>
          fsp.unlink(path.join(DOWNLOADS_DIR, name)).catch(() => {})
        )
    );
  } catch {
    // ignore
  }
}

function jobPublicState(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    title: job.title,
    filename: job.filename,
    error: job.error,
  };
}

function emitJob(job) {
  const payload = `data: ${JSON.stringify(jobPublicState(job))}\n\n`;
  for (const res of job.subscribers) {
    res.write(payload);
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  emitJob(job);
}

function scheduleJobCleanup(jobId) {
  setTimeout(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.status === "ready" || job.status === "error") {
      for (const res of job.subscribers) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      await cleanupJobFiles(jobId);
      jobs.delete(jobId);
    }
  }, JOB_TTL_MS);
}

function parseProgress(line) {
  const downloadMatch = line.match(
    /\[download\]\s+(\d+(?:\.\d+)?)%/i
  );
  if (downloadMatch) {
    return {
      stage: "downloading",
      percent: Math.min(100, parseFloat(downloadMatch[1])),
      message: `Downloading audio… ${downloadMatch[1]}%`,
    };
  }

  if (/\[ExtractAudio\]|Destination:.*\.mp3|\[info\].*Extracting audio/i.test(line)) {
    return {
      stage: "converting",
      percent: 100,
      message: "Converting to high-quality MP3…",
    };
  }

  if (/\[EmbedThumbnail\]/i.test(line)) {
    return {
      stage: "finalizing",
      percent: 100,
      message: "Embedding cover art…",
    };
  }

  if (/\[Metadata\]/i.test(line)) {
    return {
      stage: "finalizing",
      percent: 100,
      message: "Embedding metadata…",
    };
  }

  return null;
}

function runConversion(job, url) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(DOWNLOADS_DIR, `${job.id}.%(ext)s`);
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--progress",
      // Highest available YouTube audio, then max-quality MP3 (320 kbps).
      "-f",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "320K",
      "--embed-metadata",
      // YouTube thumbs are often webp; JPG is required for MP3 cover art.
      "--convert-thumbnails",
      "jpg",
      "--embed-thumbnail",
      "-o",
      outputTemplate,
      "--print",
      "before_dl:title",
      url,
    ];

    const child = spawn("yt-dlp", args, {
      windowsHide: true,
      env: process.env,
    });

    job.child = child;
    let stdout = "";
    let stderr = "";
    let titleFromPrint = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!titleFromPrint && !trimmed.startsWith("[")) {
          titleFromPrint = trimmed;
          updateJob(job, {
            title: sanitizeFilename(titleFromPrint),
            message: `Preparing “${sanitizeFilename(titleFromPrint)}”…`,
          });
        }
        const progress = parseProgress(trimmed);
        if (progress) updateJob(job, progress);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const progress = parseProgress(trimmed);
        if (progress) updateJob(job, progress);
      }
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          Object.assign(new Error("yt-dlp was not found."), {
            code: "MISSING_YTDLP",
          })
        );
        return;
      }
      reject(err);
    });

    child.on("close", async (code) => {
      job.child = null;
      if (code !== 0) {
        reject(
          Object.assign(new Error((stderr || stdout || "yt-dlp failed").trim()), {
            code: "YTDLP_FAILED",
          })
        );
        return;
      }

      try {
        const entries = await fsp.readdir(DOWNLOADS_DIR);
        const mp3Name = entries.find(
          (name) =>
            name.startsWith(job.id) && name.toLowerCase().endsWith(".mp3")
        );
        if (!mp3Name) {
          reject(new Error("Conversion finished but no MP3 was found."));
          return;
        }

        const mp3Path = path.join(DOWNLOADS_DIR, mp3Name);
        const stat = await fsp.stat(mp3Path);
        if (!stat.size) {
          reject(new Error("The converted MP3 file was empty."));
          return;
        }

        const title =
          sanitizeFilename(titleFromPrint) ||
          sanitizeFilename(
            stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l && !l.startsWith("["))
          ) ||
          "audio";

        resolve({
          mp3Path,
          title,
          filename: `${title}.mp3`,
          size: stat.size,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function startJob(job, url) {
  activeJobs += 1;
  updateJob(job, {
    status: "running",
    stage: "starting",
    percent: 0,
    message: "Starting download…",
  });

  try {
    await ensureDownloadsDir();
    const result = await runConversion(job, url);
    job.filePath = result.mp3Path;
    job.size = result.size;
    updateJob(job, {
      status: "ready",
      stage: "ready",
      percent: 100,
      title: result.title,
      filename: result.filename,
      message: "Ready — starting download…",
    });
    scheduleJobCleanup(job.id);
  } catch (err) {
    await cleanupJobFiles(job.id);
    updateJob(job, {
      status: "error",
      stage: "error",
      percent: 0,
      error: humanError(err),
      message: humanError(err),
    });
    scheduleJobCleanup(job.id);
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function binaryAvailable(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

app.get("/api/health", async (_req, res) => {
  const [ytDlp, ffmpeg] = await Promise.all([
    binaryAvailable("yt-dlp", ["--version"]),
    binaryAvailable("ffmpeg", ["-version"]),
  ]);
  res.json({ ok: ytDlp && ffmpeg, ytDlp, ffmpeg, activeJobs });
});

app.post("/api/jobs", async (req, res) => {
  const url = req.body?.url;

  if (!isYouTubeUrl(url)) {
    return res.status(400).json({
      error:
        "Please provide a valid YouTube URL (youtube.com, youtu.be, or Shorts).",
    });
  }

  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: "Too many conversions in progress. Please try again in a moment.",
    });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    status: "queued",
    stage: "queued",
    percent: 0,
    message: "Queued…",
    title: null,
    filename: null,
    error: null,
    filePath: null,
    size: 0,
    subscribers: new Set(),
    child: null,
    createdAt: Date.now(),
  };

  jobs.set(id, job);
  res.status(201).json({ id });
  setImmediate(() => startJob(job, url.trim()));
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  job.subscribers.add(res);
  res.write(`data: ${JSON.stringify(jobPublicState(job))}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    job.subscribers.delete(res);
  });
});

// JSON payload avoids IDM/browser download managers hijacking attachment URLs.
app.get("/api/jobs/:id/payload", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "ready" || !job.filePath) {
    return res.status(409).json({ error: "File is not ready yet." });
  }

  try {
    const buffer = await fsp.readFile(job.filePath);
    if (!buffer.length) {
      return res.status(500).json({ error: "The MP3 file is empty." });
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      filename: job.filename || "audio.mp3",
      size: buffer.length,
      base64: buffer.toString("base64"),
    });
  } catch {
    return res.status(500).json({ error: "Failed to read the MP3 file." });
  }
});

ensureDownloadsDir()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`YouTube → MP3 running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to create downloads directory:", err);
    process.exit(1);
  });
