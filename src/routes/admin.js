const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const h = require('../helpers');
const files = require('../files');
const stripe = require('../payments/stripe');
const paymob = require('../payments/paymob');

const router = express.Router();
router.use(h.requireAdmin);

// Parses a file upload, then checks the form token. Upload errors become a friendly message.
function withUpload(field) {
  return (req, res, next) => {
    files.upload.single(field)(req, res, (err) => {
      if (err) {
        if (req.file) files.remove(req.file.filename);
        h.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message);
        return res.redirect(req.get('referer') || '/admin');
      }
      h.csrfCheck(req, res, next);
    });
  };
}
const on = v => (v === 'on' || v === '1' || v === 'true' ? 1 : 0);

// ---------- dashboard ----------
router.get('/', (req, res) => {
  const revenue = db.prepare(`SELECT currency, SUM(amount_cents) total, COUNT(*) n FROM orders WHERE status = 'paid' AND amount_cents > 0 GROUP BY currency`).all();
  const revenue30 = db.prepare(`SELECT currency, SUM(amount_cents) total FROM orders WHERE status = 'paid' AND paid_at > datetime('now', '-30 days') GROUP BY currency`).all();
  const stats = {
    students: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'student'`).get().c,
    enrollments: db.prepare('SELECT COUNT(*) c FROM enrollments').get().c,
    courses: db.prepare('SELECT COUNT(*) c FROM courses').get().c,
    certificates: db.prepare('SELECT COUNT(*) c FROM certificates').get().c,
  };
  const recent = db.prepare(`SELECT o.*, u.name, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 8`).all();
  const top = db.prepare(`SELECT c.title, c.slug, COUNT(e.id) n FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id GROUP BY c.id ORDER BY n DESC LIMIT 5`).all();
  res.render('admin/dashboard', { title: 'Dashboard', revenue, revenue30, stats, recent, top, stripeOn: stripe.enabled(), paymobOn: paymob.enabled() });
});

// ---------- courses ----------
router.get('/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) lessons,
    (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) students FROM courses c ORDER BY c.created_at DESC`).all();
  res.render('admin/courses', { title: 'Courses', courses });
});
router.get('/courses/new', (req, res) => res.render('admin/course-form', { title: 'New course', course: {}, isNew: true }));

function courseFields(body) {
  return {
    title: String(body.title || '').trim() || 'Untitled course',
    subtitle: String(body.subtitle || '').trim(),
    description: String(body.description || ''),
    price_usd_cents: h.toCents(body.price_usd),
    price_egp_cents: h.toCents(body.price_egp),
    published: on(body.published),
    cert_enabled: on(body.cert_enabled),
  };
}

router.post('/courses', withUpload('image'), (req, res) => {
  const f = courseFields(req.body);
  const slug = h.uniqueSlug('courses', req.body.slug || f.title);
  const r = db.prepare(`INSERT INTO courses (slug, title, subtitle, description, price_usd_cents, price_egp_cents, published, cert_enabled, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, f.title, f.subtitle, f.description, f.price_usd_cents, f.price_egp_cents, f.published, f.cert_enabled, req.file ? req.file.filename : null);
  db.prepare('INSERT INTO sections (course_id, title, position) VALUES (?, ?, 0)').run(r.lastInsertRowid, 'Getting started');
  h.flash(req, 'success', 'Course created. Now add your lessons.');
  res.redirect(`/admin/courses/${r.lastInsertRowid}`);
});

router.get('/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id));
  if (!course) return res.redirect('/admin/courses');
  res.render('admin/course-edit', { title: course.title, course, sections: h.curriculum(course.id) });
});

router.post('/courses/:id', withUpload('image'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id));
  if (!course) return res.redirect('/admin/courses');
  const f = courseFields(req.body);
  const slug = req.body.slug ? h.uniqueSlug('courses', req.body.slug, course.id) : course.slug;
  let image = course.image_path;
  if (req.file) { files.remove(course.image_path); image = req.file.filename; }
  if (on(req.body.remove_image)) { files.remove(course.image_path); image = null; }
  db.prepare(`UPDATE courses SET slug=?, title=?, subtitle=?, description=?, price_usd_cents=?, price_egp_cents=?, published=?, cert_enabled=?, image_path=? WHERE id=?`)
    .run(slug, f.title, f.subtitle, f.description, f.price_usd_cents, f.price_egp_cents, f.published, f.cert_enabled, image, course.id);
  h.flash(req, 'success', 'Course saved.');
  res.redirect(`/admin/courses/${course.id}`);
});

router.post('/courses/:id/delete', h.csrfCheck, (req, res) => {
  const id = Number(req.params.id);
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
  if (course) {
    for (const l of db.prepare('SELECT * FROM lessons WHERE course_id = ?').all(id)) { files.remove(l.file_path); if (l.pdf_path !== l.file_path) files.remove(l.pdf_path); }
    files.remove(course.image_path);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  }
  h.flash(req, 'success', 'Course deleted.');
  res.redirect('/admin/courses');
});

// ---------- sections ----------
function normalize(table, whereCol, whereVal) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE ${whereCol} = ? ORDER BY position, id`).all(whereVal);
  rows.forEach((r, i) => db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(i, r.id));
  return rows.map(r => r.id);
}
function move(table, whereCol, whereVal, id, dir) {
  const ids = normalize(table, whereCol, whereVal);
  const i = ids.indexOf(id), j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return;
  db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(j, ids[i]);
  db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(i, ids[j]);
}

router.post('/courses/:id/sections', h.csrfCheck, (req, res) => {
  const id = Number(req.params.id);
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM sections WHERE course_id = ?').get(id).p;
  db.prepare('INSERT INTO sections (course_id, title, position) VALUES (?, ?, ?)').run(id, String(req.body.title || '').trim() || 'New section', pos);
  res.redirect(`/admin/courses/${id}#curriculum`);
});
router.post('/sections/:sid', h.csrfCheck, (req, res) => {
  const s = db.prepare('SELECT * FROM sections WHERE id = ?').get(Number(req.params.sid));
  if (!s) return res.redirect('/admin/courses');
  if (req.body.action === 'up' || req.body.action === 'down') move('sections', 'course_id', s.course_id, s.id, req.body.action);
  else if (req.body.action === 'delete') {
    for (const l of db.prepare('SELECT * FROM lessons WHERE section_id = ?').all(s.id)) { files.remove(l.file_path); if (l.pdf_path !== l.file_path) files.remove(l.pdf_path); }
    db.prepare('DELETE FROM sections WHERE id = ?').run(s.id);
  } else db.prepare('UPDATE sections SET title = ? WHERE id = ?').run(String(req.body.title || '').trim() || s.title, s.id);
  res.redirect(`/admin/courses/${s.course_id}#curriculum`);
});

// ---------- lessons ----------
const LESSON_TYPES = ['video', 'document', 'text', 'quiz'];
router.post('/sections/:sid/lessons', h.csrfCheck, (req, res) => {
  const s = db.prepare('SELECT * FROM sections WHERE id = ?').get(Number(req.params.sid));
  if (!s) return res.redirect('/admin/courses');
  const type = LESSON_TYPES.includes(req.body.type) ? req.body.type : 'text';
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM lessons WHERE section_id = ?').get(s.id).p;
  const r = db.prepare('INSERT INTO lessons (section_id, course_id, title, type, position) VALUES (?, ?, ?, ?, ?)')
    .run(s.id, s.course_id, String(req.body.title || '').trim() || 'New lesson', type, pos);
  res.redirect(`/admin/lessons/${r.lastInsertRowid}`);
});

router.get('/lessons/:lid', (req, res) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.lid));
  if (!lesson) return res.redirect('/admin/courses');
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(lesson.course_id);
  const sections = db.prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position, id').all(course.id);
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lesson.id)
    .map(q => ({ ...q, options: JSON.parse(q.options_json) }));
  res.render('admin/lesson-edit', { title: lesson.title, lesson, course, sections, questions, embed: h.embedUrl(lesson.video_url), kind: files.kindOf(lesson.file_path) });
});

router.post('/lessons/:lid', withUpload('file'), async (req, res) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.lid));
  if (!lesson) return res.redirect('/admin/courses');
  const b = req.body;
  let { file_path, file_name, pdf_path } = lesson;
  const clearFile = () => { files.remove(file_path); if (pdf_path && pdf_path !== file_path) files.remove(pdf_path); file_path = file_name = pdf_path = null; };

  if (req.file) {
    const kind = files.kindOf(req.file.originalname);
    const wanted = lesson.type === 'video' ? 'video' : lesson.type === 'document' ? 'document' : null;
    if (kind !== wanted && !(lesson.type === 'text' && kind === 'document')) {
      files.remove(req.file.filename);
      h.flash(req, 'error', lesson.type === 'video' ? 'Please upload a video file (MP4, WebM or MOV).' : 'Please upload a PDF, Word, PowerPoint or Excel file.');
      return res.redirect(`/admin/lessons/${lesson.id}`);
    }
    clearFile();
    file_path = req.file.filename; file_name = req.file.originalname;
    if (kind === 'document') {
      pdf_path = await files.convertToPdf(file_path);
      if (!pdf_path) h.flash(req, 'error', 'The file was saved, but a browser preview could not be made. Students can still download it.');
    }
  } else if (on(b.remove_file)) clearFile();

  const sectionId = Number(b.section_id) || lesson.section_id;
  const validSection = db.prepare('SELECT 1 FROM sections WHERE id = ? AND course_id = ?').get(sectionId, lesson.course_id);
  db.prepare(`UPDATE lessons SET title=?, section_id=?, video_url=?, content=?, free_preview=?, allow_download=?, pass_percent=?,
    file_path=?, file_name=?, pdf_path=? WHERE id=?`).run(
    String(b.title || '').trim() || lesson.title, validSection ? sectionId : lesson.section_id,
    String(b.video_url || '').trim() || null, String(b.content || ''), on(b.free_preview), on(b.allow_download),
    Math.min(100, Math.max(0, Number(b.pass_percent) || 70)), file_path, file_name, pdf_path, lesson.id);
  if (!req.session.flash) h.flash(req, 'success', 'Lesson saved.');
  res.redirect(`/admin/lessons/${lesson.id}`);
});

router.post('/lessons/:lid/action', h.csrfCheck, (req, res) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.lid));
  if (!lesson) return res.redirect('/admin/courses');
  if (req.body.action === 'delete') {
    files.remove(lesson.file_path); if (lesson.pdf_path !== lesson.file_path) files.remove(lesson.pdf_path);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(lesson.id);
    h.flash(req, 'success', 'Lesson deleted.');
  } else if (req.body.action === 'up' || req.body.action === 'down') move('lessons', 'section_id', lesson.section_id, lesson.id, req.body.action);
  res.redirect(`/admin/courses/${lesson.course_id}#curriculum`);
});

// ---------- quiz questions ----------
function questionFields(b) {
  const raw = [].concat(b.options || []).map(s => String(s).trim());
  const keep = raw.map((t, i) => ({ t, i })).filter(o => o.t);
  const options = keep.map(o => o.t);
  const correct = Math.max(0, keep.findIndex(o => o.i === Number(b.correct)));
  return { question: String(b.question || '').trim(), options, correct, explanation: String(b.explanation || '').trim() };
}
router.post('/lessons/:lid/questions', h.csrfCheck, (req, res) => {
  const lid = Number(req.params.lid);
  const q = questionFields(req.body);
  if (!q.question || q.options.length < 2) h.flash(req, 'error', 'A question needs text and at least two answers.');
  else {
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM quiz_questions WHERE lesson_id = ?').get(lid).p;
    db.prepare('INSERT INTO quiz_questions (lesson_id, question, options_json, correct_index, explanation, position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(lid, q.question, JSON.stringify(q.options), q.correct, q.explanation, pos);
  }
  res.redirect(`/admin/lessons/${lid}#questions`);
});
router.post('/questions/:qid', h.csrfCheck, (req, res) => {
  const existing = db.prepare('SELECT * FROM quiz_questions WHERE id = ?').get(Number(req.params.qid));
  if (!existing) return res.redirect('/admin/courses');
  if (req.body.action === 'delete') db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(existing.id);
  else if (req.body.action === 'up' || req.body.action === 'down') move('quiz_questions', 'lesson_id', existing.lesson_id, existing.id, req.body.action);
  else {
    const q = questionFields(req.body);
    if (!q.question || q.options.length < 2) h.flash(req, 'error', 'A question needs text and at least two answers.');
    else db.prepare('UPDATE quiz_questions SET question=?, options_json=?, correct_index=?, explanation=? WHERE id=?')
      .run(q.question, JSON.stringify(q.options), q.correct, q.explanation, existing.id);
  }
  res.redirect(`/admin/lessons/${existing.lesson_id}#questions`);
});

// ---------- students ----------
router.get('/students', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const students = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM enrollments WHERE user_id = u.id) courses,
    (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE user_id = u.id AND status='paid' AND currency='USD') spent_usd,
    (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE user_id = u.id AND status='paid' AND currency='EGP') spent_egp
    FROM users u WHERE (? = '' OR u.email LIKE ? OR u.name LIKE ?) ORDER BY u.created_at DESC LIMIT 500`).all(q, like, like);
  res.render('admin/students', { title: 'Students', students, q });
});
router.get('/students/export.csv', (req, res) => {
  const rows = db.prepare(`SELECT u.name, u.email, u.role, u.created_at, GROUP_CONCAT(c.title, '; ') courses FROM users u
    LEFT JOIN enrollments e ON e.user_id = u.id LEFT JOIN courses c ON c.id = e.course_id GROUP BY u.id ORDER BY u.created_at`).all();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(['name,email,role,joined,courses', ...rows.map(r => [r.name, r.email, r.role, r.created_at, r.courses].map(esc).join(','))].join('\n'));
});
router.get('/students/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!student) return res.redirect('/admin/students');
  const enrolled = db.prepare(`SELECT c.*, e.source, e.created_at enrolled_at FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ?`).all(student.id)
    .map(c => ({ ...c, progress: h.courseProgress(student.id, c.id) }));
  const others = db.prepare('SELECT * FROM courses WHERE id NOT IN (SELECT course_id FROM enrollments WHERE user_id = ?) ORDER BY title').all(student.id);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(student.id);
  res.render('admin/student', { title: student.name, student, enrolled, others, orders });
});
router.post('/students/:id', h.csrfCheck, (req, res) => {
  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!student) return res.redirect('/admin/students');
  const a = req.body.action;
  if (a === 'enroll' && req.body.course_id) { h.enroll(student.id, Number(req.body.course_id), 'manual'); h.flash(req, 'success', 'Student enrolled.'); }
  if (a === 'unenroll') { db.prepare('DELETE FROM enrollments WHERE user_id = ? AND course_id = ?').run(student.id, Number(req.body.course_id)); h.flash(req, 'success', 'Access removed.'); }
  if (a === 'password') {
    const pw = String(req.body.password || '');
    if (pw.length < 8) h.flash(req, 'error', 'Password must be at least 8 characters.');
    else { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), student.id); h.flash(req, 'success', 'Password changed. Share it with the student securely.'); }
  }
  if (a === 'role' && student.id !== req.user.id) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(student.role === 'admin' ? 'student' : 'admin', student.id);
    h.flash(req, 'success', 'Role updated.');
  }
  res.redirect(`/admin/students/${student.id}`);
});
router.post('/students', h.csrfCheck, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), name = String(req.body.name || '').trim(), pw = String(req.body.password || '');
  if (!email || !name || pw.length < 8) { h.flash(req, 'error', 'Name, email and a password of 8+ characters are required.'); return res.redirect('/admin/students'); }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) { h.flash(req, 'error', 'That email already has an account.'); return res.redirect('/admin/students'); }
  const r = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, name, bcrypt.hashSync(pw, 10));
  res.redirect(`/admin/students/${r.lastInsertRowid}`);
});

// ---------- orders ----------
router.get('/orders', (req, res) => {
  const status = ['paid', 'pending', 'failed'].includes(req.query.status) ? req.query.status : '';
  const orders = db.prepare(`SELECT o.*, u.name, u.email, cp.code coupon FROM orders o JOIN users u ON u.id = o.user_id
    LEFT JOIN coupons cp ON cp.id = o.coupon_id WHERE (? = '' OR o.status = ?) ORDER BY o.id DESC LIMIT 500`).all(status, status);
  res.render('admin/orders', { title: 'Orders', orders, status });
});
router.post('/orders/:id/mark-paid', h.csrfCheck, (req, res) => {
  require('../payments/fulfill').fulfillOrder(Number(req.params.id), 'manual');
  h.flash(req, 'success', 'Order marked as paid and the student was enrolled.');
  res.redirect('/admin/orders');
});

// ---------- coupons ----------
router.get('/coupons', (req, res) => {
  const coupons = db.prepare('SELECT * FROM coupons ORDER BY id DESC').all();
  const courses = db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  const bundles = db.prepare('SELECT id, title FROM bundles ORDER BY title').all();
  const names = {};
  courses.forEach(c => (names['course:' + c.id] = c.title)); bundles.forEach(b => (names['bundle:' + b.id] = b.title + ' (bundle)'));
  res.render('admin/coupons', { title: 'Coupons', coupons, courses, bundles, names });
});
router.post('/coupons', h.csrfCheck, (req, res) => {
  const b = req.body;
  const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) { h.flash(req, 'error', 'Enter a coupon code.'); return res.redirect('/admin/coupons'); }
  if (db.prepare('SELECT 1 FROM coupons WHERE code = ? COLLATE NOCASE').get(code)) { h.flash(req, 'error', 'That code already exists.'); return res.redirect('/admin/coupons'); }
  const [itemType, itemId] = String(b.applies_to || '').split(':');
  db.prepare(`INSERT INTO coupons (code, kind, percent_off, amount_usd_cents, amount_egp_cents, max_uses, expires_at, item_type, item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, b.kind === 'fixed' ? 'fixed' : 'percent',
    Math.min(100, Math.max(0, Number(b.percent_off) || 0)), h.toCents(b.amount_usd), h.toCents(b.amount_egp),
    Number(b.max_uses) || null, b.expires_at || null, itemType || null, itemId ? Number(itemId) : null);
  h.flash(req, 'success', `Coupon ${code} created.`);
  res.redirect('/admin/coupons');
});
router.post('/coupons/:id', h.csrfCheck, (req, res) => {
  const id = Number(req.params.id);
  if (req.body.action === 'delete') db.prepare('DELETE FROM coupons WHERE id = ?').run(id);
  else db.prepare('UPDATE coupons SET active = 1 - active WHERE id = ?').run(id);
  res.redirect('/admin/coupons');
});

// ---------- bundles ----------
router.get('/bundles', (req, res) => {
  const bundles = db.prepare('SELECT * FROM bundles ORDER BY id DESC').all().map(b => h.getItem('bundle', b.id));
  res.render('admin/bundles', { title: 'Bundles', bundles });
});
router.get('/bundles/new', (req, res) => res.render('admin/bundle-form', { title: 'New bundle', bundle: { courses: [] }, allCourses: db.prepare('SELECT * FROM courses ORDER BY title').all(), isNew: true }));
router.get('/bundles/:id', (req, res) => {
  const bundle = h.getItem('bundle', Number(req.params.id));
  if (!bundle) return res.redirect('/admin/bundles');
  res.render('admin/bundle-form', { title: bundle.title, bundle, allCourses: db.prepare('SELECT * FROM courses ORDER BY title').all(), isNew: false });
});
function saveBundleCourses(id, list) {
  db.prepare('DELETE FROM bundle_courses WHERE bundle_id = ?').run(id);
  for (const cid of [].concat(list || [])) db.prepare('INSERT OR IGNORE INTO bundle_courses (bundle_id, course_id) VALUES (?, ?)').run(id, Number(cid));
}
router.post('/bundles', h.csrfCheck, (req, res) => {
  const b = req.body, title = String(b.title || '').trim() || 'Untitled bundle';
  const r = db.prepare('INSERT INTO bundles (slug, title, description, price_usd_cents, price_egp_cents, published) VALUES (?, ?, ?, ?, ?, ?)')
    .run(h.uniqueSlug('bundles', title), title, String(b.description || ''), h.toCents(b.price_usd), h.toCents(b.price_egp), on(b.published));
  saveBundleCourses(r.lastInsertRowid, b.courses);
  h.flash(req, 'success', 'Bundle created.');
  res.redirect('/admin/bundles');
});
router.post('/bundles/:id', h.csrfCheck, (req, res) => {
  const id = Number(req.params.id), b = req.body;
  if (b.action === 'delete') { db.prepare('DELETE FROM bundles WHERE id = ?').run(id); h.flash(req, 'success', 'Bundle deleted.'); return res.redirect('/admin/bundles'); }
  db.prepare('UPDATE bundles SET title=?, description=?, price_usd_cents=?, price_egp_cents=?, published=? WHERE id=?')
    .run(String(b.title || '').trim() || 'Untitled bundle', String(b.description || ''), h.toCents(b.price_usd), h.toCents(b.price_egp), on(b.published), id);
  saveBundleCourses(id, b.courses);
  h.flash(req, 'success', 'Bundle saved.');
  res.redirect(`/admin/bundles/${id}`);
});

module.exports = router;
