require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { pipeline } = require("stream");
const util = require("util");

const streamPipeline = util.promisify(pipeline);

const app = express();

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  JWT_SECRET,
  CHAT_JSON_REMOTE_URL,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_ENDPOINT, // e.g., https://<accountid>.r2.cloudflarestorage.com
} = process.env;

const PORT = process.env.PORT || 3333;
const CHAT_JSON_DEST = path.join(__dirname, "chat.json");

// R2 client
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Download chat.json if missing
if (!fs.existsSync(CHAT_JSON_DEST)) {
  (async () => {
    console.log("📄 chat.json not found — downloading from remote URL…");
    try {
      const response = await axios.get(CHAT_JSON_REMOTE_URL, {
        responseType: "stream",
      });
      const file = fs.createWriteStream(CHAT_JSON_DEST);
      response.data.pipe(file);
      file.on("finish", () => {
        file.close();
        console.log("✅ chat.json downloaded and saved.");
      });
    } catch (err) {
      console.error(`❌ Failed to download chat.json: ${err.message}`);
    }
  })();
}

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://rad-arithmetic-166bae.netlify.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT helper functions
function generateToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.split(" ")[1];
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Login route
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = generateToken(username);
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false });
});

// Check auth
app.get("/api/check", (req, res) => {
  const payload = verifyToken(req);
  res.json({ loggedIn: !!payload });
});

// Chat data
app.get("/api/chat", (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).send("Unauthorized");

  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.pageSize, 10) || 50;

  let chatData = [];
  try {
    chatData = JSON.parse(fs.readFileSync(CHAT_JSON_DEST, "utf-8"));
  } catch (err) {
    console.error("Failed to read chat.json:", err.message);
    return res.status(500).send("Server error");
  }

  const totalMessages = chatData.length;
  const totalPages = Math.ceil(totalMessages / pageSize);

  const start = Math.max(totalMessages - page * pageSize, 0);
  const end = totalMessages - (page - 1) * pageSize;

  const pageMessages = chatData.slice(start, end);

  res.json({ messages: pageMessages, page, totalPages });
});

// Temporary files cleanup
const tempTimers = {};
function scheduleCleanup(tmpPath) {
  const filename = path.basename(tmpPath);
  if (tempTimers[filename]) clearTimeout(tempTimers[filename]);

  tempTimers[filename] = setTimeout(() => {
    if (fs.existsSync(tmpPath)) {
      fs.unlink(tmpPath, (err) => {
        if (err) {
          console.error(`Failed to delete ${tmpPath}:`, err.message);
        } else {
          console.log(`🧹 Deleted temp file: ${tmpPath}`);
        }
      });
    }
    delete tempTimers[filename];
  }, 10 * 1000);
}

// Media route
app.get("/api/media/:filename", async (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).send("Unauthorized");

  const filename = req.params.filename;
  const tmpPath = path.join("/tmp", filename);

  if (fs.existsSync(tmpPath)) {
    console.log(`[cache] serving ${filename}`);
    return res.sendFile(tmpPath, {}, (err) => {
      if (!err) scheduleCleanup(tmpPath);
    });
  }

  console.log(`[download] ${filename} not cached, downloading…`);

  try {
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: filename,
    });

    const r2Response = await s3.send(command);

    const writeStream = fs.createWriteStream(tmpPath);
    await streamPipeline(r2Response.Body, writeStream);

    console.log(`[done] downloaded & cached ${filename}`);

    return res.sendFile(tmpPath, {}, (err) => {
      if (!err) scheduleCleanup(tmpPath);
    });
  } catch (err) {
    console.error(`❌ Failed to download from R2: ${err.message}`);
    return res.status(500).send("Failed to download from R2");
  }
});

app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
