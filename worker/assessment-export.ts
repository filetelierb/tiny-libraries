import {
  assessmentMarkdown,
  type AssessmentDetail,
  type AssessmentImageData,
} from '../shared/assessments';
import { validateAssessmentImages } from './assessment-vision';

export const assessmentExportPolicy =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function reportMarkup(markdown: string) {
  return markdown
    .split('\n')
    .map((line) => {
      const heading = line.match(/^(#{1,4}) (.*)$/);
      if (heading) return `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`;
      if (!line.trim()) return '';
      if (line.trimStart().startsWith('>'))
        return `<blockquote>${escape(line.trimStart().slice(1).trimStart())}</blockquote>`;
      return `<p>${escape(line)}</p>`;
    })
    .join('\n');
}

/** A standalone report contains only selected flattened bytes, with no scripts or external requests. */
export function assessmentHTML(detail: AssessmentDetail, images: AssessmentImageData[]) {
  if (!detail.report) throw new Error('Complete the assessment before exporting its report.');
  const selected = validateAssessmentImages(detail.context, images),
    figures = selected
      .map(
        ({ attachment, image }, index) => `<figure id="image-${image.id}">
      <img src="${escape(images[index].data)}" alt="${escape(image.capture?.label || attachment.name)}">
      <figcaption>${index + 1}. ${escape(image.capture?.label || attachment.name)}</figcaption>
      <p>${escape(attachment.name)}${attachment.annotationRevision ? ` · note revision ${attachment.annotationRevision}` : ''}</p>
      <details><summary>Saved image identity</summary><p>Snapshot ${attachment.id}<br>Image ${image.id}<br>SHA-256 ${image.digest}${image.capture ? `<br>Drawing ${image.capture.drawingDigest}` : ''}</p></details>
    </figure>`,
      )
      .join('\n');
  return `<!doctype html><html lang="${detail.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(assessmentExportPolicy)}"><title>${escape(detail.title)}</title>
  <style>body{margin:0;background:#f7f5ec;color:#1c3039;font:18px/1.6 Georgia,'Times New Roman',serif}main{max-width:960px;margin:32px auto;padding:40px;background:#fffefa;border:1px solid #ddd8c9}h1,h2,h3,h4{line-height:1.25}h2{margin-top:2em;border-top:1px solid #ddd8c9;padding-top:1em}p{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:3px solid #007c76;margin:1em 0;padding-left:1em;color:#445b62}figure{margin:2em 0;padding:1em;border:1px solid #ddd8c9;break-inside:avoid}img{display:block;max-width:100%;height:auto;margin:auto}figcaption{font-weight:bold;margin-top:.75em}summary{cursor:pointer}details{font-size:.85em;overflow-wrap:anywhere}@media(max-width:640px){main{margin:0;padding:20px}body{font-size:16px}}@media print{body{background:white}main{margin:0;padding:0;border:0}}</style></head><body><main>${reportMarkup(assessmentMarkdown(detail))}${figures ? `<h2>Selected image evidence</h2><p>Exact flattened images used for this assessment. This file works without the application or a network connection.</p>${figures}` : ''}</main></body></html>`;
}
