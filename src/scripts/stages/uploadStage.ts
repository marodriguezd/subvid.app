import { prettifyBytes } from "@/scripts/file.ts";
import type { Stage } from "@/scripts/stageManager.ts";
import type { ui as appUi } from "@/scripts/ui.ts";

type UploadStageOptions = {
  ui: typeof appUi;
  tt: (path: string, vars?: Record<string, unknown>) => string;
  setStage: (stage: Stage) => void;
  setStatus: (message: string, kind?: string) => void;
  setProgress: (percent: number) => void;
  isExporting: () => boolean;
  getVideoObjectUrl: () => string;
  setVideoObjectUrl: (url: string) => void;
  setSelectedVideoFile: (file: File | null) => void;
  resetEditorState: () => void;
  setLangAddStatus: (message: string, kind?: string) => void;
  populateAddLang: () => void;
  renderSegments: () => void;
  enableExports: (on: boolean) => void;
  resetHistory: () => void;
  startEarlyTranscription: (file: File) => void;
  resetTranscriptionCache: () => void;
};

function isVideoFile(file: File) {
  return (
    file.type.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv)$/i.test(file.name)
  );
}

function isAudioFile(file: File) {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|flac|wma|opus)$/i.test(file.name)
  );
}

function isMediaFile(file: File) {
  return isVideoFile(file) || isAudioFile(file);
}

export function createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus,
  setProgress,
  isExporting,
  getVideoObjectUrl,
  setVideoObjectUrl,
  setSelectedVideoFile,
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
  startEarlyTranscription,
  resetTranscriptionCache,
}: UploadStageOptions) {
  let dragDepth = 0;
  let unsupportedTimer: number | undefined;
  const dropzoneCopy = {
    defaultLabel:
      ui.dropzone.dataset.defaultLabel || ui.dropzoneLabel.textContent || "",
    defaultHint:
      ui.dropzone.dataset.defaultHint || ui.dropzoneHint.textContent || "",
    unsupportedLabel:
      ui.dropzone.dataset.unsupportedLabel ||
      ui.dropzoneLabel.textContent ||
      "",
    unsupportedHint:
      ui.dropzone.dataset.unsupportedHint || ui.dropzoneHint.textContent || "",
  };

  function getDraggedFileSupport(dataTransfer: DataTransfer | null) {
    const [file] = Array.from(dataTransfer?.files || []);
    if (file) return isMediaFile(file);

    const [item] = Array.from(dataTransfer?.items || []).filter(
      (dataTransferItem) => dataTransferItem.kind === "file",
    );
    if (!item) return null;
    if (item.type)
      return item.type.startsWith("video/") || item.type.startsWith("audio/");

    const itemFile = item.getAsFile();
    return itemFile ? isMediaFile(itemFile) : null;
  }

  function clearUnsupportedTimer() {
    if (!unsupportedTimer) return;
    window.clearTimeout(unsupportedTimer);
    unsupportedTimer = undefined;
  }

  function setDropzoneCopy(isUnsupported: boolean) {
    ui.dropzoneLabel.textContent = isUnsupported
      ? dropzoneCopy.unsupportedLabel
      : dropzoneCopy.defaultLabel;
    ui.dropzoneHint.textContent = isUnsupported
      ? dropzoneCopy.unsupportedHint
      : dropzoneCopy.defaultHint;
  }

  function resetDropzoneState() {
    clearUnsupportedTimer();
    ui.dropzone.classList.remove("over", "is-unsupported");
    ui.app.classList.remove("is-dragging", "is-dragging-unsupported");
    ui.dropzone.removeAttribute("aria-invalid");
    setDropzoneCopy(false);
  }

  function showSupportedDrag() {
    clearUnsupportedTimer();
    ui.dropzone.classList.add("over");
    ui.dropzone.classList.remove("is-unsupported");
    ui.app.classList.add("is-dragging");
    ui.app.classList.remove("is-dragging-unsupported");
    ui.dropzone.removeAttribute("aria-invalid");
    setDropzoneCopy(false);
  }

  function showUnsupportedFile({ dragging = false, persist = false } = {}) {
    clearUnsupportedTimer();
    ui.dropzone.classList.toggle("over", dragging);
    ui.dropzone.classList.add("is-unsupported");
    ui.app.classList.toggle("is-dragging", dragging);
    ui.app.classList.toggle("is-dragging-unsupported", dragging);
    ui.dropzone.setAttribute("aria-invalid", "true");
    setDropzoneCopy(true);

    if (persist) {
      unsupportedTimer = window.setTimeout(resetDropzoneState, 2400);
    }
  }

  function handleSelectedFile(file?: File) {
    if (!file) return;
    if (!isMediaFile(file)) {
      showUnsupportedFile({ persist: true });
      ui.input.value = "";
      return;
    }

    // Guard: prevent WebView OOM / binder TransactionTooLarge on huge files
    const MAX_SIZE = 100 * 1024 * 1024; // 100 MB
    if (file.size > MAX_SIZE) {
      setStatus(`File too large (${prettifyBytes(file.size)}). Try a file under 100 MB.`, "error");
      ui.input.value = "";
      return;
    }

    const isAudio = isAudioFile(file);

    resetDropzoneState();
    resetTranscriptionCache();

    const previousUrl = getVideoObjectUrl();
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    let videoObjectUrl: string;
    try {
      videoObjectUrl = URL.createObjectURL(file);
    } catch (e: any) {
      setStatus(e?.message || "Failed to load file.", "error");
      ui.input.value = "";
      return;
    }
    setSelectedVideoFile(file);
    setVideoObjectUrl(videoObjectUrl);
    try {
      ui.video.src = videoObjectUrl;
      ui.video.load();
    } catch (e: any) {
      console.warn("[upload] video.load failed", e);
    }
    try {
      ui.configVideo.src = videoObjectUrl;
      ui.configVideo.load();
    } catch (e: any) {
      console.warn("[upload] configVideo.load failed", e);
    }

    // Hide video elements and export options for audio-only files
    // Keep preview containers visible so subtitles can be displayed
    if (isAudio) {
      ui.configPreview.style.display = "none";
      ui.video.style.display = "none"; // Hide video element but keep container
      ui.downloadVideoBtn.style.display = "none";
      ui.exportFormat.closest("label")?.setAttribute("style", "display: none");
      ui.exportQuality.closest("label")?.setAttribute("style", "display: none");
    } else {
      ui.configPreview.style.display = "";
      ui.video.style.display = "";
      ui.downloadVideoBtn.style.display = "";
      ui.exportFormat.closest("label")?.removeAttribute("style");
      ui.exportQuality.closest("label")?.removeAttribute("style");
    }

    resetEditorState();
    ui.langTabs.innerHTML = "";
    setLangAddStatus("");
    populateAddLang();
    renderSegments();
    ui.addSegBtn.disabled = true;
    enableExports(false);
    resetHistory();
    ui.generationTime.hidden = true;
    ui.generationTime.textContent = "";

    ui.outputLang.value = "same";
    ui.inputLang.value = "";
    ui.wordAnimation.checked = false;

    const metaText = `${file.name} · ${prettifyBytes(file.size)}`;
    ui.meta.textContent = metaText;
    ui.configMeta.textContent = metaText;
    setStatus(tt("videoLoaded"), "ok");
    setProgress(0);
    ui.configProgress.hidden = true;
    ui.configError.hidden = true;
    ui.configError.textContent = "";
    setStage("config");
    startEarlyTranscription(file);
  }

  function resetFlow() {
    if (isExporting()) return;

    const videoObjectUrl = getVideoObjectUrl();
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
      setVideoObjectUrl("");
    }

    setSelectedVideoFile(null);
    resetTranscriptionCache();
    resetEditorState();
    ui.langTabs.innerHTML = "";
    ui.generationTime.hidden = true;
    ui.generationTime.textContent = "";
    setLangAddStatus("");
    populateAddLang();
    ui.caption.textContent = "";
    ui.video.removeAttribute("src");
    ui.video.load();
    ui.configVideo.removeAttribute("src");
    ui.configVideo.load();
    enableExports(false);
    resetHistory();
    setStage("upload");
  }

  function attachGlobalDrop() {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes("Files");

    document.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      const isSupported = getDraggedFileSupport(event.dataTransfer);
      if (isSupported === false) showUnsupportedFile({ dragging: true });
      else showSupportedDrag();
    });
    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const isSupported = getDraggedFileSupport(event.dataTransfer);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isSupported === false ? "none" : "copy";
      }
      if (isSupported === false) showUnsupportedFile({ dragging: true });
      else showSupportedDrag();
    });
    document.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) resetDropzoneState();
    });
    document.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      resetDropzoneState();
      handleSelectedFile(event.dataTransfer?.files?.[0]);
    });
  }

  function wireUploadStage() {
    attachGlobalDrop();
    // Prevent WebView crash on unsupported codecs (e.g. hevc) – show status instead of killing process
    const onVideoError = () => {
      const err = (ui.video.error as any)?.message || "Video preview failed (unsupported codec). Audio extraction may still work – try Generate.";
      console.warn("[upload] video preview error", err, ui.video.error);
      // Keep file selected; user can still try transcription via FFmpeg (supports hevc via libx265)
      setStatus(err, "error");
    };
    ui.video.addEventListener("error", onVideoError);
    ui.configVideo.addEventListener("error", onVideoError);

    ui.dropzone.addEventListener("click", () => ui.input.click());
    ui.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        ui.input.click();
      }
    });
    ui.input.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement | null;
      try {
        handleSelectedFile(target?.files?.[0]);
      } catch (e: any) {
        console.error("[upload] handleSelectedFile crash", e);
        setStatus(e?.message || "Failed to load file.", "error");
      } finally {
        // Always clear input so same file can be re-selected after error
        if (target) target.value = "";
      }
    });
    ui.configBackBtn.addEventListener("click", resetFlow);
  }

  return {
    handleSelectedFile,
    resetFlow,
    attachGlobalDrop,
    wireUploadStage,
  };
}
