require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Storage } = require("megajs");

const app = express();

const { ADMIN_USERNAME, ADMIN_PASSWORD, MEGA_EMAIL, MEGA_PASSWORD } =
  process.env;

const PORT = process.env.PORT || 3333;
const CHAT_JSON_SECRET_PATH = "/etc/secrets/chat.json"; // adjust if your hosting platform uses another path
const CHAT_JSON_DEST = path.join(__dirname, "chat.json");

if (!fs.existsSync(CHAT_JSON_DEST)) {
  console.log("📄 Writing chat.json from secret file...");
  fs.copyFileSync(CHAT_JSON_SECRET_PATH, CHAT_JSON_DEST);
}

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: "super_secret_123",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

// Track temp file cleanup timers
const tempTimers = {}; // filename -> timeoutId

function scheduleCleanup(tmpPath) {
  const filename = path.basename(tmpPath);

  // clear any existing timer (reset it if file is accessed again)
  if (tempTimers[filename]) {
    clearTimeout(tempTimers[filename]);
  }

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
  }, 10 * 1000); // 10 seconds
}

// delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

app.get("/api/check", (req, res) => {
  res.json({ loggedIn: !!req.session.loggedIn });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/chat", (req, res) => {
  if (!req.session.loggedIn) return res.status(401).send("Unauthorized");

  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.pageSize, 10) || 50;

  let chatData = [];
  try {
    chatData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "chat.json"), "utf-8")
    );
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

app.get("/api/media/:filename", async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).send("Unauthorized");

  const filename = req.params.filename;
  const tmpPath = path.join("/tmp", filename);

  if (fs.existsSync(tmpPath)) {
    console.log(`[cache] serving ${filename}`);
    return res.sendFile(tmpPath, {}, (err) => {
      if (err) {
        console.error(`Failed to send file ${tmpPath}:`, err.message);
      } else {
        scheduleCleanup(tmpPath);
      }
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
        if (err) {
          console.error(`Failed to send file ${tmpPath}:`, err.message);
        } else {
          scheduleCleanup(tmpPath);
        }
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
