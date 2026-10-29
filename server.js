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
const METADATA_FILE = path.join(__dirname, 'data', 'videos.json');

// Ensure local data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(METADATA_FILE)) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify([], null, 2));
}

function getVideos() {
  try {
    const data = fs.readFileSync(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Public API: Get videos with search and filtering
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

// Streaming & HTTP Range Request Support
app.get('/api/stream/:id', async (req, res) => {
  const videos = getVideos();
  const video = videos.find(v => v.id === req.params.id);

  if (!video) {
    return res.status(404).send('Video not found.');
  }

  // If videoUrl is a direct HTTP/HTTPS link, redirect directly
  if (video.videoUrl && video.videoUrl.startsWith('http')) {
    return res.redirect(video.videoUrl);
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

app.listen(PORT, () => {
  console.log(`Buckeye Vault running on port ${PORT}`);
});
