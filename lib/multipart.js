// server/lib/multipart.js
//
// Minimal `multipart/form-data` parser for a single file field. Used by
// the product-image upload route to avoid pulling in `multer`/`busboy`.
//
// Supports:
//   - Single file field (default name "image")
//   - One-shot limit (no streaming to disk)
//   - Total payload + per-file byte size cap
//
// Returns: { fieldName, filename, mime, buffer } or null if no file
// was present in the request.
//
// Why not Formidable/multer: the project has zero non-built deps for
// upload handling, and adding a dep for a single field is overkill. The
// parser is short enough to audit and only handles what we need.

const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB envelope

const parseFile = async (req, { fieldName = "image", maxBytes = 2 * 1024 * 1024 } = {}) => {
  const ctype = String(req.headers["content-type"] || "");
  const m = ctype.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) {
    const err = new Error("Expected multipart/form-data");
    err.status = 400;
    throw err;
  }
  const boundary = `--${m[1] || m[2]}`;
  const buf = await readAllWithLimit(req, MAX_TOTAL_BYTES);
  const text = buf.toString("latin1");

  // Split on boundary. Each part begins with "--<boundary>\r\n" and
  // ends with "\r\n--<boundary>". The terminating boundary is
  // "--<boundary>--".
  const parts = text.split(boundary);
  for (const part of parts) {
    // Trim leading CRLF after boundary, trailing CRLF before next boundary.
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    if (!trimmed || trimmed === "--") continue;

    // Header/body split: headers are CRLF-separated, terminated by a
    // blank CRLF, then body follows until the next boundary.
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerBlock = trimmed.slice(0, headerEnd);
    const body = trimmed.slice(headerEnd + 4);

    // Parse Content-Disposition + Content-Type from the part headers.
    const cd = /Content-Disposition:\s*form-data;\s*([^;]+(?:;\s*[^;]+)*)/i.exec(headerBlock);
    if (!cd) continue;

    const nameMatch = /\bname="([^"]*)"/i.exec(cd[1]);
    const filenameMatch = /\bfilename="([^"]*)"/i.exec(cd[1]);
    if (!nameMatch) continue;
    if (nameMatch[1] !== fieldName) continue;

    // Strip any trailing CRLF (browsers append \r\n before the boundary).
    let bin = body;
    if (bin.endsWith("\r\n")) bin = bin.slice(0, -2);

    // Body is latin1-decoded; binary-safe round-trip via Buffer.
    const fileBuf = Buffer.from(bin, "latin1");
    if (fileBuf.length > maxBytes) {
      const err = new Error(`File too large (max ${maxBytes} bytes)`);
      err.status = 413;
      throw err;
    }

    const ct = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock);
    const mime = ct ? ct[1].trim() : "application/octet-stream";
    const filename = filenameMatch ? filenameMatch[1] : "";

    return { fieldName: nameMatch[1], filename, mime, buffer: fileBuf };
  }
  return null;
};

const readAllWithLimit = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error("Payload too large");
        err.status = 413;
        req.destroy(err);
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

module.exports = { parseFile };
