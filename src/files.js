const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');
const config = require('./config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  },
});

const ALLOWED = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  video: ['.mp4', '.webm', '.mov', '.m4v'],
  document: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.pps', '.ppsx', '.odt', '.odp', '.xls', '.xlsx', '.rtf', '.txt'],
};

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = Object.values(ALLOWED).some(list => list.includes(ext));
    cb(ok ? null : new Error('That file type is not supported.'), ok);
  },
});

function kindOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return Object.keys(ALLOWED).find(k => ALLOWED[k].includes(ext)) || null;
}

function abs(stored) { return path.join(config.uploadsDir, path.basename(stored)); }

function remove(stored) {
  if (!stored) return;
  fs.promises.unlink(abs(stored)).catch(() => {});
}

// Converts Word / PowerPoint / Excel files to PDF with LibreOffice so students can view them in the browser.
function convertToPdf(stored) {
  return new Promise((resolve) => {
    const src = abs(stored);
    if (path.extname(src).toLowerCase() === '.pdf') return resolve(path.basename(src));
    const outDir = config.uploadsDir;
    const profile = 'file://' + path.join(require('os').tmpdir(), 'lo-profile-' + process.pid);
    execFile('soffice', ['-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf', '--outdir', outDir, src],
      { timeout: 180000 }, (err) => {
        const pdf = src.replace(/\.[^.]+$/, '.pdf');
        if (err || !fs.existsSync(pdf)) {
          console.error('PDF conversion failed:', err ? err.message : 'no output');
          return resolve(null);
        }
        resolve(path.basename(pdf));
      });
  });
}

module.exports = { upload, kindOf, abs, remove, convertToPdf, ALLOWED };
