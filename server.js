require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { fal } = require("@fal-ai/client");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

fal.config({ credentials: process.env.FAL_KEY });

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const VIDEO_MODEL = "blackforestlabs/flux-3/text-to-video/draft";
const TTS_MODEL = "fal-ai/gemini-3.1-flash-tts";
const LIPSYNC_MODEL = "veed/lipsync/v2";

const PORT = process.env.PORT || 3000;

async function generateScript(feature, attempt = 1) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      thinking: { type: "disabled" },
      messages: [{
        role: "user",
        content: `A JotPsych feature: "${feature}".

Write a script of 30 to 60 words — not shorter, not much longer. This is a strict requirement, count your words before responding.

Make it genuinely FUNNY, not just cheerful. Include an actual joke: a pun, a punchline, a self-aware quip, or an unexpected comparison. Structure it like a tiny stand-up bit — a setup, then a twist or payoff.

Respond ONLY with raw JSON, no markdown fences, no preamble, and NO actual line breaks inside the string values (keep all text for each field on a single line):
{
  "animal": "a specific fun animal",
  "script": "your script here with a real joke",
  "videoPrompt": "A realistic and funny video of the chosen animal acting like a human and speaking what the script says, it has to show the mouth and face of the animal during the video to lipsync, shaped like a vertical phone screen. The video must feature JotPsych brand colors [Midnight #1C1E85, Deep #1E125E, Warm #FFF2F5, Sunset #FD96C9, Afterglow #813FE8] integrated as ambient glow or lights, and the animal's actions must match what is being described."
}`
      }],
    }),
  });

  const data = await response.json();
  const textBlock = data.content && data.content.find(block => block.type === "text");
  if (!textBlock) {
    throw new Error("Anthropic API error: " + JSON.stringify(data));
  }

  let text = textBlock.text.replace(/```json|```/g, "").trim();

  let result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse JSON string. Raw text was:", text);
    if (attempt < 2) {
      console.log("Retrying generation due to JSON parse error...");
      return generateScript(feature, attempt + 1);
    }
    throw new Error("Model returned malformed JSON after retry.");
  }

  const wordCount = result.script.trim().split(/\s+/).length;
  console.log(`Script word count: ${wordCount} (attempt ${attempt})`);

  if ((wordCount < 25 || wordCount > 45) && attempt < 2) {
    console.log("Script length off target, retrying...");
    return generateScript(feature, attempt + 1);
  }

  return result;
}

// Stage 1: generate script, start silent video, generate TTS audio
app.post("/api/generate", async (req, res) => {
  try {
    const { feature } = req.body;
    const { animal, script, videoPrompt } = await generateScript(feature);
    console.log("Script generated:", { animal, script, videoPrompt });

    let videoJob;
    try {
      console.log("Submitting video job to primary model...");
      videoJob = await fal.queue.submit(VIDEO_MODEL, {
        input: { 
          prompt: videoPrompt, 
          duration: 15,
          aspect_ratio: "9:16" 
        },
      });
    } catch (primaryErr) {
      console.warn("Primary video model failed with downstream error, using fallback prompt...", primaryErr.message);
      
      const fallbackPrompt = `A vertical phone screen video of a ${animal} acting like a human, professional office setting, purple and pink ambient lighting, high quality, realistic.`;
      
      videoJob = await fal.queue.submit(VIDEO_MODEL, {
        input: { 
          prompt: fallbackPrompt, 
          duration: 10,
          aspect_ratio: "9:16" 
        },
      });
    }

    const ttsResult = await fal.subscribe(TTS_MODEL, {
      input: { prompt: script },
    });
    console.log("TTS result:", JSON.stringify(ttsResult.data, null, 2));

    const audioUrl = ttsResult.data.audio.url;

    res.json({
      videoRequestId: videoJob.request_id,
      audioUrl,
      script,
      animal,
    });
  } catch (err) {
    console.error("generate error:", err);
    if (err.body) console.error("Full validation detail:", JSON.stringify(err.body, null, 2));
    res.status(500).json({ error: "Failed to start generation", details: err.message });
  }
});

// Stage 2: poll silent video, then kick off lipsync once ready
app.get("/api/status/video/:requestId", async (req, res) => {
  try {
    const { audioUrl } = req.query;
    const status = await fal.queue.status(VIDEO_MODEL, {
      requestId: req.params.requestId,
      logs: true,
    });

    if (status.status !== "COMPLETED") {
      return res.json({ status: status.status });
    }

    const result = await fal.queue.result(VIDEO_MODEL, {
      requestId: req.params.requestId,
    });
    const videoUrl = result.data.video.url;
    console.log("Silent video ready:", videoUrl);

    const lipsyncJob = await fal.queue.submit(LIPSYNC_MODEL, {
      input: { video_url: videoUrl, audio_url: audioUrl },
    });

    res.json({ status: "lipsync_started", lipsyncRequestId: lipsyncJob.request_id });
  } catch (err) {
    console.error("video status error:", err);
    if (err.body) console.error("Full validation detail:", JSON.stringify(err.body, null, 2));
    res.status(500).json({ error: "Failed to check video status" });
  }
});

// Stage 3: poll lipsync job
app.get("/api/status/lipsync/:requestId", async (req, res) => {
  try {
    const status = await fal.queue.status(LIPSYNC_MODEL, {
      requestId: req.params.requestId,
      logs: true,
    });

    if (status.status !== "COMPLETED") {
      return res.json({ status: status.status });
    }

    const result = await fal.queue.result(LIPSYNC_MODEL, {
      requestId: req.params.requestId,
    });
    console.log("Lipsync result:", JSON.stringify(result.data, null, 2));

    res.json({ status: "done", videoUrl: result.data.video.url });
  } catch (err) {
    console.error("lipsync status error:", err);
    if (err.body) console.error("Full validation detail:", JSON.stringify(err.body, null, 2));
    res.status(500).json({ error: "Failed to check lipsync status" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));