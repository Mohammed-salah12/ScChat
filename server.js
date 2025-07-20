require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { Storage } = require("megajs");

const app = express();

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  MEGA_EMAIL,
  MEGA_PASSWORD,
  CHAT_JSON_REMOTE_URL,
  JWT_SECRET = "super_secret_123",
} = process.env;

const PORT = process.env.PORT || 3333;
const CHAT_JSON_DEST = path.join(__dirname, "chat.json");

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
      "https://charming-pastelito-c271fa.netlify.app",
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

// Delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const storage = new Storage({
        email: MEGA_EMAIL,
        password: MEGA_PASSWORD,
      });

      await new Promise((resolve, reject) => {
        storage.on("ready", resolve);
        storage.on("error", reject);
      });

      const mediaFolder = storage.root.children.find(
        (f) => f.name === "media" && f.directory
      );

      if (!mediaFolder) {
        storage.close();
        return res.status(404).send("media folder not found");
      }

      const file = mediaFolder.children.find((f) => f.name === filename);

      if (!file) {
        storage.close();
        return res.status(404).send("file not found in media");
      }

      const ws = fs.createWriteStream(tmpPath);

      await new Promise((resolve, reject) => {
        file.download().pipe(ws).on("finish", resolve).on("error", reject);
      });

      storage.close();
      console.log(`[done] downloaded & cached ${filename}`);

      return res.sendFile(tmpPath, {}, (err) => {
        if (!err) scheduleCleanup(tmpPath);
      });
    } catch (err) {
      console.error(`attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await delay(3000);
        continue;
      }
      return res.status(500).send("failed to download from MEGA");
    }
  }
});

app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
