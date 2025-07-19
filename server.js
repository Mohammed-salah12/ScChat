require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();

const { ADMIN_USERNAME, ADMIN_PASSWORD, MEGA_EXEC_PATH } = process.env;

app.use(
  cors({
    origin: "http://localhost:3000", // frontend origin
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("/*any", cors());
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

const PORT = process.env.PORT || 3333;
const MEGA_EXEC = MEGA_EXEC_PATH;

// LOGIN
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

// CHECK LOGIN
app.get("/api/check", (req, res) => {
  res.json({ loggedIn: !!req.session.loggedIn });
});

// LOGOUT
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// CHAT MESSAGES (paginated)
app.get("/api/chat", (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).send("Unauthorized");
  }

  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;

  const chatData = JSON.parse(
    fs.readFileSync(path.join(__dirname, "chat.json"), "utf-8")
  );

  const totalMessages = chatData.length;
  const totalPages = Math.ceil(totalMessages / pageSize);

  const start = Math.max(totalMessages - page * pageSize, 0);
  const end = totalMessages - (page - 1) * pageSize;

  const pageMessages = chatData.slice(start, end);

  res.json({
    messages: pageMessages,
    page,
    totalPages,
  });
});

// SERVE MEDIA SECURELY
app.get("/api/media/:filename", (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).send("Unauthorized");
  }

  const filename = req.params.filename;
  const tmpPath = path.join("/tmp", filename);

  const cmd = `${MEGA_EXEC} get "/media/${filename}" "${tmpPath}"`;

  console.log(`Running: ${cmd}`);
  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`Failed to fetch ${filename}:`, err);
      console.error(stderr);
      return res.status(500).send("Error fetching file from MEGA");
    }

    res.sendFile(tmpPath, (sendErr) => {
      if (sendErr) {
        console.error("Error sending file:", sendErr);
      }
      fs.unlink(tmpPath, () => {}); // clean up
    });
  });
});

// Start server
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
