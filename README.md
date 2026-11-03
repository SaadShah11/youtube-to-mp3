# TubeTone — YouTube → MP3

A simple local web app that converts a YouTube link into a high-quality MP3 using **yt-dlp** and **ffmpeg**.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your PATH
- [ffmpeg](https://ffmpeg.org/) on your PATH

### Install yt-dlp and ffmpeg on Windows

**winget (recommended):**

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
```

**scoop:**

```powershell
scoop install yt-dlp ffmpeg
```

**chocolatey:**

```powershell
choco install yt-dlp ffmpeg
```

After installing, **open a new terminal** so PATH updates apply, then verify:

```powershell
yt-dlp --version
ffmpeg -version
```

## Setup

```powershell
cd "d:\SAAD SHAH\Development\youtube-mp3"
npm install
```

## Run

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000), paste a YouTube URL, and click **Convert**.

Optional: set a custom port with `PORT=4000 npm start` (PowerShell: `$env:PORT=4000; npm start`).

## How quality works

YouTube’s best audio is usually Opus or M4A. This app extracts the **best available audio** (`bestaudio/best`) and converts it to MP3 with **`--audio-quality 0`** (highest quality / VBR). That is the best MP3 quality without inventing detail that wasn’t in the source.

## Notes

- Personal / local use only. Respect copyright and YouTube’s terms of service.
- Temp files are written under `downloads/` and removed after the browser download finishes.
- At most 2 conversions run at once.
