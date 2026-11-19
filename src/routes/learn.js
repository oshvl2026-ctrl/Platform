const express = require('express');
const fs = require('fs');
const db = require('../db');
const h = require('../helpers');
const files = require('../files');
const { renderCertificate } = require('../certificate');

const router = express.Router();

router.get('/my-courses', h.requireLogin, (req, res) => {
  const courses = db.prepare(`SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id
    WHERE e.user_id = ? ORDER BY e.created_at DESC`).all(req.user.id);
  for (const c of courses) {
    c.progress = h.courseProgress(req.user.id, c.id);
    c.certificate = db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ?').get(req.user.id, c.id);
  }
  res.render('my-courses', { title: 'My courses', courses });
});

function loadLesson(req, res) {
  const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(req.params.slug);
  if (!course) { res.status(404).render('error', { title: 'Not found', message: 'Course not found.' }); return null; }
  const lessons = h.orderedLessons(course.id);
  const lesson = req.params.lessonId ? lessons.find(l => l.id === Number(req.params.lessonId)) : null;
  const access = h.canAccessCourse(req.user, course.id);
  return { course, lessons, lesson, access };
}

router.get('/learn/:slug', h.requireLogin, (req, res) => {
  const ctx = loadLesson(req, res); if (!ctx) return;
  if (!ctx.access) return res.redirect(`/courses/${ctx.course.slug}`);
  if (!ctx.lessons.length) return res.render('error', { title: ctx.course.title, message: 'Lessons are coming soon.' });
  const done = h.completedSet(req.user.id, ctx.course.id);
  const next = ctx.lessons.find(l => !done.has(l.id)) || ctx.lessons[0];
  res.redirect(`/learn/${ctx.course.slug}/${next.id}`);
});

router.get('/learn/:slug/:lessonId', (req, res) => {
  const ctx = loadLesson(req, res); if (!ctx) return;
  const { course, lessons, lesson, access } = ctx;
  if (!lesson) return res.redirect(`/courses/${course.slug}`);
  if (!access && !lesson.free_preview) {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    h.flash(req, 'error', 'Enroll in this course to open that lesson.');
    return res.redirect(`/courses/${course.slug}`);
  }
  const sections = h.curriculum(course.id);
  const done = req.user ? h.completedSet(req.user.id, course.id) : new Set();
  const idx = lessons.findIndex(l => l.id === lesson.id);
  const questions = lesson.type === 'quiz'
    ? db.prepare('SELECT * FROM quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lesson.id).map(q => ({ ...q, options: JSON.parse(q.options_json) }))
    : [];
  const lastAttempt = (lesson.type === 'quiz' && req.user)
    ? db.prepare('SELECT * FROM quiz_attempts WHERE user_id = ? AND lesson_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id, lesson.id)
    : null;
  if (lastAttempt) lastAttempt.answers = JSON.parse(lastAttempt.answers_json || '[]');
  const progress = req.user ? h.courseProgress(req.user.id, course.id) : null;
  const certificate = req.user ? db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ?').get(req.user.id, course.id) : null;
  res.render('learn', {
    title: `${lesson.title} · ${course.title}`, course, sections, lesson, done, access, questions, lastAttempt, progress, certificate,
    prev: lessons[idx - 1], next: lessons[idx + 1], embed: h.embedUrl(lesson.video_url), showResult: req.query.result === '1',
  });
});

router.post('/learn/:slug/:lessonId/complete', h.requireLogin, (req, res) => {
  const ctx = loadLesson(req, res); if (!ctx) return;
  if (!ctx.access || !ctx.lesson || ctx.lesson.type === 'quiz') return res.redirect(`/courses/${ctx.course.slug}`);
  const cert = h.markComplete(req.user.id, ctx.lesson);
  const idx = ctx.lessons.findIndex(l => l.id === ctx.lesson.id);
  const next = ctx.lessons[idx + 1];
  if (cert && !req.body.stay) h.flash(req, 'success', 'Course complete! Your certificate is ready.');
  if (req.get('accept') === 'application/json') return res.json({ ok: true });
  res.redirect(next && !req.body.stay ? `/learn/${ctx.course.slug}/${next.id}` : `/learn/${ctx.course.slug}/${ctx.lesson.id}`);
});

router.post('/learn/:slug/:lessonId/quiz', h.requireLogin, (req, res) => {
  const ctx = loadLesson(req, res); if (!ctx) return;
  const { course, lesson, access } = ctx;
  if (!access || !lesson || lesson.type !== 'quiz') return res.redirect(`/courses/${course.slug}`);
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lesson.id);
  const answers = questions.map(q => (req.body['q' + q.id] === undefined ? null : Number(req.body['q' + q.id])));
  const correct = questions.filter((q, i) => answers[i] === q.correct_index).length;
  const score = questions.length ? Math.round((correct / questions.length) * 100) : 100;
  const passed = score >= lesson.pass_percent ? 1 : 0;
  db.prepare('INSERT INTO quiz_attempts (user_id, lesson_id, score, passed, answers_json) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, lesson.id, score, passed, JSON.stringify(answers));
  if (passed) {
    const cert = h.markComplete(req.user.id, lesson);
    if (cert) h.flash(req, 'success', 'Course complete! Your certificate is ready.');
  }
  res.redirect(`/learn/${course.slug}/${lesson.id}?result=1`);
});

// ---------- protected media ----------
function lessonForMedia(req, res) {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.id));
  if (!lesson) { res.status(404).end(); return null; }
  if (!lesson.free_preview && !h.canAccessCourse(req.user, lesson.course_id)) { res.status(403).send('Enroll to access this file.'); return null; }
  return lesson;
}

router.get('/media/:id/video', (req, res) => {
  const lesson = lessonForMedia(req, res); if (!lesson) return;
  if (!lesson.file_path || files.kindOf(lesson.file_path) !== 'video') return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(files.abs(lesson.file_path));
});

router.get('/media/:id/view', (req, res) => {
  const lesson = lessonForMedia(req, res); if (!lesson) return;
  if (!lesson.pdf_path || !fs.existsSync(files.abs(lesson.pdf_path))) return res.status(404).send('Preview not available.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(files.abs(lesson.pdf_path));
});

router.get('/media/:id/download', (req, res) => {
  const lesson = lessonForMedia(req, res); if (!lesson) return;
  const isAdmin = req.user && req.user.role === 'admin';
  if (!lesson.file_path || (!lesson.allow_download && !isAdmin)) return res.status(403).send('Downloads are turned off for this file.');
  res.download(files.abs(lesson.file_path), lesson.file_name || 'download');
});

// ---------- certificates ----------
router.get('/certificates/:code.pdf', (req, res) => {
  const cert = db.prepare(`SELECT ce.*, u.name student, c.title course FROM certificates ce
    JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id WHERE ce.code = ?`).get(String(req.params.code).toUpperCase());
  if (!cert) return res.status(404).render('error', { title: 'Not found', message: 'Certificate not found.' });
  renderCertificate(res, { studentName: cert.student, courseTitle: cert.course, issuedAt: cert.issued_at, code: cert.code });
});

module.exports = router;
