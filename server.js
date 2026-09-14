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

const MODEL = "blackforestlabs/flux-3/text-to-video/draft";

// Start a video job
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    const { request_id } = await fal.queue.submit(MODEL, {
      input: { prompt, duration: 5 },
    });
    res.json({ requestId: request_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start generation" });
  }
});

// Poll for status
app.get("/api/status/:requestId", async (req, res) => {
  try {
    const status = await fal.queue.status(MODEL, {
      requestId: req.params.requestId,
      logs: true,
    });
    if (status.status === "COMPLETED") {
      const result = await fal.queue.result(MODEL, {
        requestId: req.params.requestId,
      });
      return res.json({ status: "done", videoUrl: result.data.video.url });
    }
    res.json({ status: status.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to check status" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));