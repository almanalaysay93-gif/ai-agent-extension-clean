/**
 * Offscreen document — file builder.
 *
 * PptxGenJS needs a DOM window: it reaches for document.createElement and
 * window.getComputedStyle, and a Manifest V3 service worker has neither.
 * Service workers additionally forbid runtime `import()` and do not expose
 * URL.createObjectURL, so the deck cannot be built in the worker at all.
 *
 * This document is created on demand by the background worker, builds the
 * .pptx here, and hands back base64. The worker turns that into a data: URL
 * for chrome.downloads, which works from the worker.
 */
import PptxGenJS from 'pptxgenjs';

type SlideSpec = { title?: string; bullets?: string[] };

async function buildPptx(slides: SlideSpec[]): Promise<string> {
  const pres = new PptxGenJS();
  pres.defineLayout({ name: 'CUSTOM', width: 10, height: 7.5 });
  pres.layout = 'CUSTOM';
  pres.author = 'AlAi Agent';

  for (const slide of slides) {
    const slideObj = pres.addSlide();
    slideObj.addText(slide.title ?? '', {
      x: 0.5,
      y: 0.4,
      w: 9,
      h: 1.2,
      fontSize: 28,
      bold: true,
      color: '1F2937',
    });
    const bullets = (slide.bullets ?? []).filter(
      (b) => typeof b === 'string' && b.trim().length > 0,
    );
    if (bullets.length > 0) {
      slideObj.addText(
        bullets.map((text) => ({ text })),
        {
          x: 0.7,
          y: 1.9,
          w: 8.6,
          h: 5.2,
          fontSize: 16,
          color: '374151',
          bullet: { code: '25CF' },
          lineSpacing: 28,
          valign: 'top',
        },
      );
    }
  }

  return (await pres.write({ outputType: 'base64' })) as string;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== 'OFFSCREEN_BUILD_PPTX') return false;
  buildPptx(Array.isArray(request.slides) ? request.slides : []).then(
    (base64) => sendResponse({ ok: true, base64 }),
    (error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return true; // async response
});
