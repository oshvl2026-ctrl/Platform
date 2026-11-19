// Renders a lesson PDF page by page so documents and slides display on every device.
import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const box = document.getElementById('docview');
if (box) {
  const count = document.getElementById('pagecount');
  try {
    const pdf = await pdfjs.getDocument({ url: box.dataset.src, withCredentials: true }).promise;
    box.innerHTML = '';
    count.textContent = pdf.numPages === 1 ? '1 page' : `${pdf.numPages} pages`;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const holder = document.createElement('div');
      holder.className = 'docpage';
      holder.dataset.page = n;
      holder.style.aspectRatio = '1 / 1.414';
      box.appendChild(holder);
      pages.push(holder);
    }
    const draw = async (holder) => {
      if (holder.dataset.done) return;
      holder.dataset.done = '1';
      const page = await pdf.getPage(Number(holder.dataset.page));
      const base = page.getViewport({ scale: 1 });
      const width = holder.clientWidth || box.clientWidth;
      const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.setAttribute('aria-label', `Page ${holder.dataset.page}`);
      holder.style.aspectRatio = `${base.width} / ${base.height}`;
      holder.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    };
    const io = new IntersectionObserver((entries) => entries.forEach(e => e.isIntersecting && draw(e.target)), { root: box, rootMargin: '600px 0px' });
    pages.forEach(p => io.observe(p));
    draw(pages[0]);
  } catch (e) {
    box.innerHTML = '<p style="padding:20px">This file could not be shown here. Try downloading it instead.</p>';
    console.warn(e);
  }
  document.getElementById('fullscreen')?.addEventListener('click', () => {
    if (box.requestFullscreen) box.requestFullscreen(); else if (box.webkitRequestFullscreen) box.webkitRequestFullscreen();
  });
}
