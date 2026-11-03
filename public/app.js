const form = document.getElementById("convert-form");
const urlInput = document.getElementById("url");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const progressPanel = document.getElementById("progress-panel");
const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");

let activeSource = null;

function setBusy(busy) {
  submitBtn.disabled = busy;
  urlInput.disabled = busy;
  statusEl.classList.toggle("is-busy", busy);
}

function setError(message) {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function showProgress(show) {
  progressPanel.hidden = !show;
  if (!show) {
    progressFill.style.width = "0%";
    progressFill.classList.remove("is-indeterminate");
    progressBar.setAttribute("aria-valuenow", "0");
    progressPercent.textContent = "0%";
    progressLabel.textContent = "Starting…";
  }
}

function updateProgress(event) {
  const percent = Math.max(0, Math.min(100, Number(event.percent) || 0));
  const converting =
    event.stage === "converting" || event.stage === "finalizing";

  progressLabel.textContent = event.message || "Working…";
  progressPercent.textContent = converting ? "…" : `${Math.round(percent)}%`;
  progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressFill.classList.toggle(
    "is-indeterminate",
    converting && percent >= 100
  );
  progressFill.style.width = `${percent}%`;
}

function closeSource() {
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
}

function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    closeSource();
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    activeSource = source;

    source.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }

      updateProgress(data);
      if (data.title) {
        statusEl.textContent = data.title;
      }

      if (data.status === "ready") {
        closeSource();
        resolve(data);
      } else if (data.status === "error") {
        closeSource();
        reject(new Error(data.error || "Conversion failed."));
      }
    };

    source.onerror = () => {
      closeSource();
      reject(new Error("Lost connection to the converter. Please try again."));
    };
  });
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "audio/mpeg" });
}

async function saveBlob(blob, filename) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "MP3 audio",
            accept: { "audio/mpeg": [".mp3"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "picker";
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("Save cancelled.");
      }
      // Fall through to anchor save if the picker is unavailable/blocked.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return "anchor";
}

async function downloadJobFile(jobId, fallbackName) {
  progressLabel.textContent = "Preparing file…";
  progressPercent.textContent = "100%";
  progressFill.style.width = "100%";
  progressFill.classList.remove("is-indeterminate");

  const response = await fetch(`/api/jobs/${jobId}/payload`, {
    headers: { Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Download failed.");
  }

  if (!data.base64 || !data.size) {
    throw new Error("Downloaded file was empty. Please try again.");
  }

  progressLabel.textContent = "Choose where to save…";
  const blob = base64ToBlob(data.base64);
  if (!blob.size) {
    throw new Error("Downloaded file was empty. Please try again.");
  }

  const filename = data.filename || fallbackName || "audio.mp3";
  await saveBlob(blob, filename);
  return { size: blob.size, filename };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  statusEl.textContent = "";
  closeSource();

  const url = urlInput.value.trim();
  if (!url) {
    setError("Paste a YouTube URL to continue.");
    return;
  }

  setBusy(true);
  showProgress(true);
  updateProgress({
    percent: 0,
    stage: "starting",
    message: "Starting download…",
  });

  try {
    const create = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const createBody = await create.json().catch(() => ({}));
    if (!create.ok) {
      throw new Error(createBody.error || "Could not start conversion.");
    }

    const result = await waitForJob(createBody.id);
    const saved = await downloadJobFile(createBody.id, result.filename);
    statusEl.textContent = `Saved ${saved.filename} (${Math.max(1, Math.round(saved.size / 1024))} KB)`;
    progressLabel.textContent = "Done";
  } catch (err) {
    showProgress(false);
    statusEl.textContent = "";
    setError(err.message || "Something went wrong.");
  } finally {
    setBusy(false);
  }
});
