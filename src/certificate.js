const PDFDocument = require('pdfkit');
const path = require('path');
const config = require('./config');

const ARABIC_FONT = path.join(path.dirname(require.resolve('@fontsource/noto-naskh-arabic/package.json')), 'files', 'noto-naskh-arabic-arabic-700-normal.woff');
const RTL = /[\u0590-\u08FF\uFB1D-\uFEFC]/;

// Draws a line of text centered on the page. Arabic text is laid out right to left, word by word.
function centered(doc, text, y, size, latinFont, W, margin = 60) {
  if (!RTL.test(text)) {
    doc.font(latinFont).fontSize(size).text(text, margin, y, { width: W - margin * 2, align: 'center' });
    return;
  }
  const words = text.trim().split(/\s+/).reverse();
  doc.fontSize(size);
  const font = w => (RTL.test(w) ? 'arabic' : latinFont);
  const gap = size * 0.3;
  const widths = words.map(w => doc.font(font(w)).widthOfString(w));
  let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * (words.length - 1))) / 2;
  words.forEach((w, i) => { doc.font(font(w)).text(w, x, y - size * 0.3, { lineBreak: false }); x += widths[i] + gap; });
}

function renderCertificate(res, { studentName, courseTitle, issuedAt, code }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate-${code}.pdf"`);
  doc.pipe(res);
  doc.registerFont('arabic', ARABIC_FONT);

  const W = doc.page.width, H = doc.page.height, brand = config.brandColor;
  doc.rect(0, 0, W, H).fill('#fbfaf7');
  doc.lineWidth(10).strokeColor(brand).rect(24, 24, W - 48, H - 48).stroke();
  doc.lineWidth(1).strokeColor('#c9c3b5').rect(42, 42, W - 84, H - 84).stroke();

  doc.fillColor(brand).font('Helvetica-Bold').fontSize(14)
    .text(config.siteName.toUpperCase(), 0, 90, { width: W, align: 'center', characterSpacing: 4 });
  doc.fillColor('#1f2328').font('Times-Bold').fontSize(44)
    .text('Certificate of Completion', 0, 130, { width: W, align: 'center' });
  doc.fillColor('#6b6f76').font('Helvetica').fontSize(14)
    .text('This certifies that', 0, 210, { width: W, align: 'center' });
  doc.fillColor('#1f2328');
  centered(doc, studentName, 240, 38, 'Times-BoldItalic', W);
  doc.moveTo(W / 2 - 200, 292).lineTo(W / 2 + 200, 292).lineWidth(1).strokeColor('#c9c3b5').stroke();
  doc.fillColor('#6b6f76').font('Helvetica').fontSize(14)
    .text('has successfully completed the course', 0, 312, { width: W, align: 'center' });
  doc.fillColor('#1f2328');
  centered(doc, courseTitle, 340, 24, 'Helvetica-Bold', W, 80);

  const date = new Date(issuedAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.fillColor('#1f2328').font('Helvetica').fontSize(12)
    .text(`Issued ${date}`, 90, H - 130, { width: 300 })
    .text(`Certificate ID: ${code}`, 90, H - 112, { width: 300 });
  doc.fillColor('#6b6f76').fontSize(10)
    .text(`Verify at ${config.baseUrl}/verify/${code}`, W - 390, H - 112, { width: 300, align: 'right' });
  doc.end();
}

module.exports = { renderCertificate };
