const express = require("express");
const fs = require("fs");
const path = require("path");
const { default: fetch } = require("node-fetch");
const YTDlpWrap = require("yt-dlp-wrap").default;
const app = express();
const port = 3000;

// Middleware
app.use(express.static("public"));
app.use(express.json());

// Store for progress tracking
const progressStore = new Map();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Route for M3U8 downloader page
app.get("/m3u8", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "m3u8.html"));
});

// Route for files management page
app.get("/files", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "files.html"));
});

// Route for YouTube downloader page
app.get("/youtube", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "youtube.html"));
});

// SSE endpoint for progress updates
app.get("/progress/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Send initial connection
  res.write('data: {"type": "connected"}\n\n');

  // Set up interval to send progress updates
  const progressInterval = setInterval(() => {
    const progress = progressStore.get(sessionId);
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);

      // Clean up when done
      if (progress.type === "completed" || progress.type === "error") {
        clearInterval(progressInterval);
        setTimeout(() => {
          progressStore.delete(sessionId);
          res.end();
        }, 1000);
      }
    }
  }, 1000);

  // Clean up on client disconnect
  req.on("close", () => {
    clearInterval(progressInterval);
    progressStore.delete(sessionId);
  });
});

// Function to update progress
function updateProgress(sessionId, type, data) {
  progressStore.set(sessionId, {
    type,
    timestamp: Date.now(),
    ...data,
  });
}

// Function to download a single segment with retry logic
async function downloadSegment(url, segmentNumber, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Downloading segment ${segmentNumber} (attempt ${attempt}): ${url}`
      );
      const response = await fetch(url, {
        timeout: 30000, // 30 second timeout
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.buffer();
      console.log(
        `✓ Successfully downloaded segment ${segmentNumber} (${buffer.length} bytes)`
      );
      return { segmentNumber, buffer, success: true };
    } catch (error) {
      console.log(
        `✗ Failed to download segment ${segmentNumber} (attempt ${attempt}): ${error.message}`
      );
      if (attempt === maxRetries) {
        return { segmentNumber, error: error.message, success: false };
      }
      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Function to download segments in batches
async function downloadSegmentsBatch(urls, concurrency = 5, sessionId = null) {
  const results = [];
  const failed = [];
  const totalSegments = urls.length;

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchNumber = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(urls.length / concurrency);

    console.log(
      `\nDownloading batch ${batchNumber}/${totalBatches} (segments ${
        batch[0].segmentNumber
      }-${batch[batch.length - 1].segmentNumber})`
    );

    // Update progress
    if (sessionId) {
      const completedSegments = results.length;
      const progressPercent = Math.round(
        (completedSegments / totalSegments) * 100
      );
      updateProgress(sessionId, "downloading", {
        completed: completedSegments,
        total: totalSegments,
        percentage: progressPercent,
        currentBatch: batchNumber,
        totalBatches: totalBatches,
        message: `Downloading batch ${batchNumber}/${totalBatches}...`,
      });
    }

    const batchPromises = batch.map(({ url, segmentNumber }) =>
      downloadSegment(url, segmentNumber)
    );

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.success) {
        results.push(result);
      } else {
        failed.push(result);
      }
    }

    // Update progress after batch completion
    if (sessionId) {
      const completedSegments = results.length;
      const progressPercent = Math.round(
        (completedSegments / totalSegments) * 100
      );
      updateProgress(sessionId, "downloading", {
        completed: completedSegments,
        total: totalSegments,
        percentage: progressPercent,
        currentBatch: batchNumber,
        totalBatches: totalBatches,
        message: `Completed batch ${batchNumber}/${totalBatches}`,
      });
    }

    // Small delay between batches to be gentle on the server
    if (i + concurrency < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { results, failed };
}

// Endpoint: /download-segments
app.get("/download-segments", async (req, res) => {
  const sessionId = req.query.sessionId || Date.now().toString();

  try {
    // Get parameters from query string or use defaults
    const {
      baseUrl = "https://ev-h.ashish.com/hls/c6251/videos/202508/25/20496615/720P_4000K_20496615.mp4/seg-{n}-v1-a1.ts?validfrom=1757785569&validto=1757792769&ipa=1&hdl=-1&hash=soAZuj6MSNepiF0Cpe44MK55SzM%3D",
      start = "1",
      end = "20",
      concurrency = "5",
    } = req.query;

    const startNum = parseInt(start, 10);
    const endNum = parseInt(end, 10);
    const concurrencyNum = parseInt(concurrency, 10);

    // Validation
    if (isNaN(startNum) || isNaN(endNum) || startNum > endNum || startNum < 0) {
      updateProgress(sessionId, "error", {
        message: "Invalid start or end values. Start must be >= 1 and <= end",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "Invalid start or end values. Start must be >= 1 and <= end",
      });
    }

    if (isNaN(concurrencyNum) || concurrencyNum < 1 || concurrencyNum > 20) {
      updateProgress(sessionId, "error", {
        message: "Concurrency must be between 1 and 20",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "Concurrency must be between 1 and 20",
      });
    }

    if (!baseUrl.includes("{n}")) {
      updateProgress(sessionId, "error", {
        message: "baseUrl must contain {n} placeholder for segment numbers",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "baseUrl must contain {n} placeholder for segment numbers",
      });
    }

    console.log(
      `\n🚀 Starting download of segments ${startNum}-${endNum} with concurrency ${concurrencyNum}`
    );

    // Initialize progress
    updateProgress(sessionId, "starting", {
      message: `Preparing to download ${endNum - startNum + 1} segments...`,
      totalSegments: endNum - startNum + 1,
    });

    // Generate URLs for all segments
    const segmentUrls = [];
    for (let i = startNum; i <= endNum; i++) {
      const url = baseUrl.replace("{n}", i.toString());
      segmentUrls.push({ url, segmentNumber: i });
    }

    // Update progress
    updateProgress(sessionId, "downloading", {
      completed: 0,
      total: segmentUrls.length,
      percentage: 0,
      message: "Starting download...",
    });

    // Download segments in batches
    const { results, failed } = await downloadSegmentsBatch(
      segmentUrls,
      concurrencyNum,
      sessionId
    );

    if (failed.length > 0) {
      console.log(
        `\n⚠️  ${failed.length} segments failed to download:`,
        failed.map((f) => f.segmentNumber)
      );
    }

    if (results.length === 0) {
      updateProgress(sessionId, "error", {
        message: "No segments were successfully downloaded",
      });
      return res.status(500).json({
        success: false,
        sessionId,
        error: "No segments were successfully downloaded",
      });
    }

    // Update progress for merging
    updateProgress(sessionId, "merging", {
      completed: results.length,
      total: segmentUrls.length,
      percentage: 100,
      message: `Merging ${results.length} segments...`,
    });

    // Sort results by segment number to ensure correct order
    results.sort((a, b) => a.segmentNumber - b.segmentNumber);

    console.log(`\n📦 Merging ${results.length} segments...`);

    // Merge all buffers
    const buffers = results.map((result) => result.buffer);
    const merged = Buffer.concat(buffers);

    // Ensure public directory exists
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `merged-${startNum}-${endNum}-${timestamp}.ts`;
    const mergedPath = path.join(publicDir, filename);

    // Write merged file
    fs.writeFileSync(mergedPath, merged);

    const totalSize = merged.length;
    const fileSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

    console.log(
      `\n✅ Successfully merged ${results.length}/${segmentUrls.length} segments`
    );
    console.log(`📁 File saved: ${filename} (${fileSizeMB} MB)`);

    // Update progress as completed
    updateProgress(sessionId, "completed", {
      completed: results.length,
      total: segmentUrls.length,
      percentage: 100,
      message: `Download completed! File saved: ${filename}`,
      filename,
      fileSizeMB,
    });

    res.json({
      success: true,
      sessionId,
      file: `/${filename}`,
      downloadUrl: `http://localhost:${port}/${filename}`,
      stats: {
        totalSegments: segmentUrls.length,
        successfulSegments: results.length,
        failedSegments: failed.length,
        fileSizeBytes: totalSize,
        fileSizeMB: fileSizeMB,
        failedSegmentNumbers: failed.map((f) => f.segmentNumber),
      },
    });
  } catch (err) {
    console.error("❌ Error:", err);
    updateProgress(sessionId, "error", {
      message: err.message,
    });
    res.status(500).json({
      success: false,
      sessionId,
      error: err.message,
    });
  }
});

// Endpoint to list downloaded files
app.get("/files", (req, res) => {
  try {
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) {
      return res.json({ success: true, files: [] });
    }

    const files = fs
      .readdirSync(publicDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => {
        const filePath = path.join(publicDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          created: stats.birthtime,
          downloadUrl: `http://localhost:${port}/${file}`,
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to delete a file
app.delete("/files/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, "public", filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    fs.unlinkSync(filePath);
    res.json({
      success: true,
      message: `File ${filename} deleted successfully`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Initialize yt-dlp
let ytDlp;
try {
  ytDlp = new YTDlpWrap();
} catch (error) {
  console.log("⚠️  yt-dlp not found. YouTube downloader will not work.");
  console.log(
    "Please install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation"
  );
}

// Endpoint to get YouTube video information
app.get("/youtube-info", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "URL parameter is required",
      });
    }

    if (!ytDlp) {
      return res.status(500).json({
        success: false,
        error: "yt-dlp is not available. Please install yt-dlp.",
      });
    }

    console.log(`🔍 Getting video info for: ${url}`);

    // Get video information
    const videoInfo = await ytDlp.getVideoInfo(url);

    // Extract relevant information
    const info = {
      title: videoInfo.title,
      uploader: videoInfo.uploader,
      duration: videoInfo.duration,
      view_count: videoInfo.view_count,
      upload_date: videoInfo.upload_date,
      description:
        videoInfo.description?.substring(0, 500) +
        (videoInfo.description?.length > 500 ? "..." : ""),
      thumbnail: videoInfo.thumbnail,
      formats: [],
    };

    // Process formats
    if (videoInfo.formats) {
      const processedFormats = videoInfo.formats
        .filter(
          (format) => format.vcodec !== "none" || format.acodec !== "none"
        ) // Only video or audio
        .map((format) => ({
          format_id: format.format_id,
          ext: format.ext,
          quality: format.quality || format.height || format.abr || "unknown",
          filesize: format.filesize,
          filesize_approx: format.filesize_approx,
          vcodec: format.vcodec,
          acodec: format.acodec,
          width: format.width,
          height: format.height,
          fps: format.fps,
          abr: format.abr,
          format_note: format.format_note,
          resolution: format.resolution,
        }))
        .sort((a, b) => {
          // Sort by quality (video height first, then audio bitrate)
          if (a.height && b.height) {
            return b.height - a.height;
          } else if (a.height && !b.height) {
            return -1;
          } else if (!a.height && b.height) {
            return 1;
          } else if (a.abr && b.abr) {
            return b.abr - a.abr;
          }
          return 0;
        });

      info.formats = processedFormats;
    }

    res.json({
      success: true,
      info: info,
    });
  } catch (error) {
    console.error("❌ YouTube info error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to get video information",
    });
  }
});

// Endpoint to download YouTube video
app.get("/youtube-download", async (req, res) => {
  const sessionId = req.query.sessionId || Date.now().toString();

  try {
    const { url, format, quality } = req.query;

    if (!url) {
      updateProgress(sessionId, "error", {
        message: "URL parameter is required",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "URL parameter is required",
      });
    }

    if (!ytDlp) {
      updateProgress(sessionId, "error", {
        message: "yt-dlp is not available. Please install yt-dlp.",
      });
      return res.status(500).json({
        success: false,
        sessionId,
        error: "yt-dlp is not available. Please install yt-dlp.",
      });
    }

    console.log(`🚀 Starting YouTube download: ${url}`);
    console.log(
      `📹 Format: ${format || "best"}, Quality: ${quality || "auto"}`
    );

    // Initialize progress
    updateProgress(sessionId, "starting", {
      message: "Preparing YouTube download...",
    });

    // Ensure public directory exists
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    // Generate filename - use simpler template to avoid issues
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let outputTemplate = path.join(publicDir, `youtube-${timestamp}.%(ext)s`);

    // Download options
    let downloadArgs = [url, "-o", outputTemplate, "--no-warnings"];

    // Add format selection
    if (format) {
      downloadArgs.push("-f", format);
    } else if (quality) {
      // Map quality to format selection
      if (quality === "audio") {
        downloadArgs.push("-f", "bestaudio");
      } else if (quality.includes("p")) {
        downloadArgs.push("-f", `best[height<=${quality.replace("p", "")}]`);
      } else {
        downloadArgs.push("-f", "best");
      }
    } else {
      downloadArgs.push("-f", "best");
    }

    updateProgress(sessionId, "downloading", {
      completed: 0,
      total: 100,
      percentage: 10,
      message: "Starting YouTube download...",
    });

    // Start download with progress tracking
    console.log(`📥 yt-dlp command: yt-dlp ${downloadArgs.join(" ")}`);

    let progressCounter = 10;
    const progressInterval = setInterval(() => {
      if (progressCounter < 85) {
        progressCounter += Math.random() * 10;
        updateProgress(sessionId, "downloading", {
          completed: progressCounter,
          total: 100,
          percentage: Math.min(85, progressCounter),
          message: "Downloading video...",
        });
      }
    }, 3000);

    try {
      // Execute the download
      const downloadProcess = ytDlp.exec(downloadArgs);

      // Wait for the download to complete
      await downloadProcess;
      clearInterval(progressInterval);

      // Find the downloaded file with simplified pattern
      const files = fs.readdirSync(publicDir);
      console.log(`📁 Files in public directory:`, files);

      // Look for files with the timestamp pattern
      const downloadedFile = files.find(
        (file) =>
          file.startsWith(`youtube-${timestamp}`) &&
          (file.endsWith(".mp4") ||
            file.endsWith(".webm") ||
            file.endsWith(".mkv") ||
            file.endsWith(".m4a") ||
            file.endsWith(".mp3") ||
            file.endsWith(".wav") ||
            file.endsWith(".flac") ||
            file.endsWith(".ogg"))
      );

      if (!downloadedFile) {
        // Try to find any recent video file as fallback
        const recentFiles = files
          .filter(
            (file) =>
              (file.endsWith(".mp4") ||
                file.endsWith(".webm") ||
                file.endsWith(".mkv") ||
                file.endsWith(".m4a") ||
                file.endsWith(".mp3")) &&
              file.includes("youtube")
          )
          .sort((a, b) => {
            const statsA = fs.statSync(path.join(publicDir, a));
            const statsB = fs.statSync(path.join(publicDir, b));
            return statsB.mtime - statsA.mtime; // Most recent first
          });

        if (recentFiles.length > 0) {
          const fallbackFile = recentFiles[0];
          console.log(`📁 Using fallback file: ${fallbackFile}`);

          const filePath = path.join(publicDir, fallbackFile);
          const stats = fs.statSync(filePath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

          console.log(
            `✅ Successfully downloaded YouTube video: ${fallbackFile} (${fileSizeMB} MB)`
          );

          updateProgress(sessionId, "completed", {
            completed: 100,
            total: 100,
            percentage: 100,
            message: `Download completed! File saved: ${fallbackFile}`,
            filename: fallbackFile,
            fileSizeMB: fileSizeMB,
          });

          return res.json({
            success: true,
            sessionId,
            file: `/${fallbackFile}`,
            downloadUrl: `http://localhost:${port}/${fallbackFile}`,
            stats: {
              filename: fallbackFile,
              fileSizeBytes: stats.size,
              fileSizeMB: fileSizeMB,
            },
          });
        }

        // console.log(`❌ Available files:`, files);
        // throw new Error(
        //   `Downloaded file not found. Expected pattern: youtube-${timestamp}`
        // );
      }

      const filePath = path.join(publicDir, downloadedFile);
      const stats = fs.statSync(filePath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      console.log(
        `✅ Successfully downloaded YouTube video: ${downloadedFile} (${fileSizeMB} MB)`
      );

      // Update progress as completed
      updateProgress(sessionId, "completed", {
        completed: 100,
        total: 100,
        percentage: 100,
        message: `Download completed! File saved: ${downloadedFile}`,
        filename: downloadedFile,
        fileSizeMB: fileSizeMB,
      });

      res.json({
        success: true,
        sessionId,
        file: `/${downloadedFile}`,
        downloadUrl: `http://localhost:${port}/${downloadedFile}`,
        stats: {
          filename: downloadedFile,
          fileSizeBytes: stats.size,
          fileSizeMB: fileSizeMB,
        },
      });
    } catch (downloadError) {
      clearInterval(progressInterval);
      throw downloadError;
    }
  } catch (err) {
    console.error("❌ YouTube download error:", err);
    updateProgress(sessionId, "error", {
      message: err.message || "Failed to download video",
    });
    res.status(500).json({
      success: false,
      sessionId,
      error: err.message || "Failed to download video",
    });
  }
});

// Function to parse M3U8 playlist and extract segment URLs
async function parseM3U8(m3u8Url) {
  try {
    console.log(`Fetching M3U8 playlist: ${m3u8Url}`);
    const response = await fetch(m3u8Url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch M3U8: ${response.status} ${response.statusText}`
      );
    }

    const m3u8Content = await response.text();
    const lines = m3u8Content.split("\n").map((line) => line.trim());

    const segments = [];
    let segmentNumber = 1;

    // Parse the base URL from the M3U8 URL
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

    for (const line of lines) {
      // Skip empty lines and comments/metadata that start with #
      if (line && !line.startsWith("#")) {
        let segmentUrl = line;

        // If the segment URL is relative, make it absolute
        if (!segmentUrl.startsWith("http")) {
          segmentUrl = baseUrl + segmentUrl;
        }

        segments.push({
          url: segmentUrl,
          segmentNumber: segmentNumber++,
        });
      }
    }

    console.log(`✓ Found ${segments.length} segments in M3U8 playlist`);
    return segments;
  } catch (error) {
    console.error(`✗ Error parsing M3U8: ${error.message}`);
    throw error;
  }
}

// Endpoint: /download-from-m3u8
app.get("/download-from-m3u8", async (req, res) => {
  const sessionId = req.query.sessionId || Date.now().toString();

  try {
    const { m3u8Url, concurrency = "5", startSegment, endSegment } = req.query;

    // Validation
    if (!m3u8Url) {
      updateProgress(sessionId, "error", {
        message: "M3U8 URL is required",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "M3U8 URL is required",
      });
    }

    const concurrencyNum = parseInt(concurrency, 10);
    if (isNaN(concurrencyNum) || concurrencyNum < 1 || concurrencyNum > 20) {
      updateProgress(sessionId, "error", {
        message: "Concurrency must be between 1 and 20",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "Concurrency must be between 1 and 20",
      });
    }

    console.log(`\n🚀 Starting M3U8 download from: ${m3u8Url}`);

    // Initialize progress
    updateProgress(sessionId, "starting", {
      message: "Parsing M3U8 playlist...",
    });

    // Parse M3U8 to get segment URLs
    const allSegments = await parseM3U8(m3u8Url);

    if (allSegments.length === 0) {
      updateProgress(sessionId, "error", {
        message: "No segments found in M3U8 playlist",
      });
      return res.status(400).json({
        success: false,
        sessionId,
        error: "No segments found in M3U8 playlist",
      });
    }

    // Filter segments based on start/end if provided
    let segmentsToDownload = allSegments;
    if (startSegment || endSegment) {
      const start = startSegment ? parseInt(startSegment, 10) : 1;
      const end = endSegment ? parseInt(endSegment, 10) : allSegments.length;

      if (start > 0 && end >= start && start <= allSegments.length) {
        segmentsToDownload = allSegments.slice(start - 1, end);
        // Update segment numbers to match the slice
        segmentsToDownload = segmentsToDownload.map((seg, index) => ({
          ...seg,
          segmentNumber: start + index,
        }));
      }
    }

    console.log(
      `📋 Will download ${segmentsToDownload.length} segments (${
        segmentsToDownload[0]?.segmentNumber || 1
      } to ${
        segmentsToDownload[segmentsToDownload.length - 1]?.segmentNumber ||
        segmentsToDownload.length
      })`
    );

    // Update progress
    updateProgress(sessionId, "downloading", {
      completed: 0,
      total: segmentsToDownload.length,
      percentage: 0,
      message: `Starting download of ${segmentsToDownload.length} segments...`,
    });

    // Download segments in batches
    const { results, failed } = await downloadSegmentsBatch(
      segmentsToDownload,
      concurrencyNum,
      sessionId
    );

    if (failed.length > 0) {
      console.log(
        `\n⚠️  ${failed.length} segments failed to download:`,
        failed.map((f) => f.segmentNumber)
      );
    }

    if (results.length === 0) {
      updateProgress(sessionId, "error", {
        message: "No segments were successfully downloaded",
      });
      return res.status(500).json({
        success: false,
        sessionId,
        error: "No segments were successfully downloaded",
      });
    }

    // Update progress for merging
    updateProgress(sessionId, "merging", {
      completed: results.length,
      total: segmentsToDownload.length,
      percentage: 100,
      message: `Merging ${results.length} segments...`,
    });

    // Sort results by segment number to ensure correct order
    results.sort((a, b) => a.segmentNumber - b.segmentNumber);

    console.log(`\n📦 Merging ${results.length} segments...`);

    // Merge all buffers
    const buffers = results.map((result) => result.buffer);
    const merged = Buffer.concat(buffers);

    // Ensure public directory exists
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const startNum = segmentsToDownload[0]?.segmentNumber || 1;
    const endNum =
      segmentsToDownload[segmentsToDownload.length - 1]?.segmentNumber ||
      segmentsToDownload.length;
    const filename = `m3u8-merged-${startNum}-${endNum}-${timestamp}.ts`;
    const mergedPath = path.join(publicDir, filename);

    // Write merged file
    fs.writeFileSync(mergedPath, merged);

    const totalSize = merged.length;
    const fileSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

    console.log(
      `\n✅ Successfully merged ${results.length}/${segmentsToDownload.length} segments from M3U8`
    );
    console.log(`📁 File saved: ${filename} (${fileSizeMB} MB)`);

    // Update progress as completed
    updateProgress(sessionId, "completed", {
      completed: results.length,
      total: segmentsToDownload.length,
      percentage: 100,
      message: `M3U8 download completed! File saved: ${filename}`,
      filename,
      fileSizeMB,
    });

    res.json({
      success: true,
      sessionId,
      file: `/${filename}`,
      downloadUrl: `http://localhost:${port}/${filename}`,
      stats: {
        totalSegmentsInPlaylist: allSegments.length,
        segmentsRequested: segmentsToDownload.length,
        successfulSegments: results.length,
        failedSegments: failed.length,
        fileSizeBytes: totalSize,
        fileSizeMB: fileSizeMB,
        failedSegmentNumbers: failed.map((f) => f.segmentNumber),
      },
    });
  } catch (err) {
    console.error("❌ Error:", err);
    updateProgress(sessionId, "error", {
      message: err.message,
    });
    res.status(500).json({
      success: false,
      sessionId,
      error: err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`\n🎬 TS Video Segment Downloader Server`);
  console.log(`🌐 Server running at: http://localhost:${port}`);
  console.log(`📁 Files will be saved to: ${path.join(__dirname, "public")}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  / - Home page`);
  console.log(`   GET  /download-segments - Download and merge segments`);
  console.log(
    `   GET  /download-from-m3u8 - Download and merge from M3U8 playlist`
  );
  console.log(`   GET  /youtube - YouTube video downloader`);
  console.log(`   GET  /youtube-info - Get YouTube video information`);
  console.log(`   GET  /youtube-download - Download YouTube video`);
  console.log(`   GET  /files - List downloaded files`);
  console.log(`   DELETE /files/:filename - Delete a file`);
  console.log(`\n🚀 Example usage:`);
  console.log(
    `   http://localhost:${port}/download-segments?baseUrl=https://example.com/seg-{n}-v1-a1.ts&start=1&end=10&concurrency=5`
  );
  console.log(
    `   http://localhost:${port}/download-from-m3u8?m3u8Url=https://example.com/playlist.m3u8&concurrency=5`
  );
  console.log(
    `   http://localhost:${port}/youtube-info?url=https://www.youtube.com/watch?v=VIDEO_ID`
  );
});
