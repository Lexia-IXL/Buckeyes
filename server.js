const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
require('dotenv').config();

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Cloudflare R2 Client (S3-compatible)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secureadminpassword';
const METADATA_FILE = path.join(__dirname, 'data', 'videos.json');

// Ensure local data directory exists for persistent metadata fallback
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(METADATA_FILE)) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify([], null, 2));
}

// Helper functions for metadata
function getVideos() {
  try {
    const data = fs.readFileSync(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveVideos(videos) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(videos, null, 2));
}

// Simple Admin Authentication Middleware
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const password = credentials[1];

  if (password === ADMIN_PASSWORD) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Invalid password.');
  }
}

// Configure Multer for temporary local storage before R2 upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit per upload
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Protect admin.html page route
app.get('/admin.html', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 1. PUBLIC API: Get all videos (supports filtering by category & season)
app.get('/api/videos', (req, res) => {
  const { category, season, search } = req.query;
  let videos = getVideos();

  if (category) {
    videos = videos.filter(v => v.category.toLowerCase() === category.toLowerCase());
  }
  if (season) {
    videos = videos.filter(v => v.season.toString() === season.toString());
  }
  if (search) {
    const query = search.toLowerCase();
    videos = videos.filter(v => 
      v.title.toLowerCase().includes(query) || 
      v.opponent.toLowerCase().includes(query)
    );
  }

  res.json(videos);
});

// 2. STREAMING & RANGE REQUEST SUPPORT
app.get('/api/stream/:id', async (req, res) => {
  const videos = getVideos();
  const video = videos.find(v => v.id === req.params.id);

  if (!video) {
    return res.status(404).send('Video not found.');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: video.r2Key,
    });

    const response = await s3Client.send(command);
    const headCode = response.ContentLength;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : headCode - 1;
      const chunksize = (end - start) + 1;
      
      const streamCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: video.r2Key,
        Range: `bytes=${start}-${end}`,
      });
      const chunkResponse = await s3Client.send(streamCommand);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${headCode}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });

      chunkResponse.Body.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': headCode,
        'Content-Type': 'video/mp4',
      });
      response.Body.pipe(res);
    }
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).send('Error streaming video.');
  }
});

// 3. ADMIN: Upload Video (Protected)
app.post('/api/admin/upload', adminAuth, upload.single('videoFile'), async (req, res) => {
  const { title, opponent, season, gameDate, category } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No video file provided.' });
  }

  const fileStream = fs.createReadStream(file.path);
  const r2Key = `videos/${Date.now()}-${file.originalname}`;

  try {
    const uploadCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: 'video/mp4',
    });

    await s3Client.send(uploadCommand);
    fs.unlinkSync(file.path);

    const videos = getVideos();
    const newVideo = {
      id: Date.now().toString(),
      title,
      opponent,
      season,
      gameDate,
      category,
      r2Key,
      videoUrl: `${PUBLIC_DOMAIN}/${r2Key}`,
      thumbnailUrl: `/images/default-thumb.jpg`
    };

    videos.unshift(newVideo);
    saveVideos(videos);

    res.json({ success: true, video: newVideo });
  } catch (error) {
    console.error('R2 Upload Error:', error);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: 'Failed to upload video to Cloudflare R2.' });
  }
});

// 4. ADMIN: Delete Video (Protected)
app.delete('/api/admin/video/:id', adminAuth, async (req, res) => {
  const videos = getVideos();
  const index = videos.findIndex(v => v.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Video not found.' });
  }

  const video = videos[index];

  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: video.r2Key,
    });
    await s3Client.send(deleteCommand);

    videos.splice(index, 1);
    saveVideos(videos);

    res.json({ success: true });
  } catch (error) {
    console.error('Deletion error:', error);
    res.status(500).json({ error: 'Failed to delete video from storage.' });
  }
});

app.listen(PORT, () => {
  console.log(`Buckeye Vault running on port ${PORT}`);
});
