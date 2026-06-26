import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import CDP from "chrome-remote-interface";
import { openSession, runConversation, RosettaAuthError } from "@syntaxsmith/rosetta";

const HOST = process.env.ROSETTA_HOST || "0.0.0.0";
const PORT = Number(process.env.ROSETTA_PORT || 3000);
const CDP_HOST = process.env.ROSETTA_CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.ROSETTA_CDP_PORT || 9222);
const API_KEY = process.env.ROSETTA_API_KEY || "";
const DEFAULT_MODEL = process.env.ROSETTA_DEFAULT_MODEL || "gpt-5-5";
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const IMAGE_DIR = process.env.ROSETTA_IMAGE_DIR || "/data/generated-images";
const UPLOAD_DIR = process.env.ROSETTA_UPLOAD_DIR || "/data/uploads/openai";
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const PUBLIC_BASE_URL = (process.env.ROSETTA_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const exposedModels = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.5-thinking",
  "gpt-5-5",
  "gpt-5-5-pro",
  "gpt-5-5-thinking",
  "gpt-image-2",
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function openaiError(message, type = "server_error", code = null) {
  return { error: { message, type, param: null, code } };
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_KEY}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "image_url" || part.type === "input_image") return "";
        if (part.type === "input_text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  if (messages.length === 1 && messages[0]?.role === "user") return textFromContent(messages[0].content);
  return messages
    .map((m) => `${String(m.role || "user").toUpperCase()}: ${textFromContent(m.content)}`)
    .join("\n\n");
}

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "image_url") {
    if (typeof part.image_url === "string") return part.image_url;
    if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  }
  if (part.type === "input_image") {
    if (typeof part.image_url === "string") return part.image_url;
    if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  }
  return null;
}

function imageUrlsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map(imageUrlFromPart).filter(Boolean);
}

function imageUrlsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => imageUrlsFromContent(message?.content));
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase().replace(/^\./, "");
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  } catch {}
  return null;
}

function assertInputImageSize(buffer, source) {
  if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`input image is too large (${buffer.length} bytes): ${source}`);
  }
}

async function materializeInputImage(imageUrl, index) {
  await mkdir(UPLOAD_DIR, { recursive: true });
  let mime = "image/png";
  let buffer;
  const dataMatch = /^data:([^;,]+);base64,(.+)$/s.exec(String(imageUrl));
  if (dataMatch) {
    mime = dataMatch[1].toLowerCase();
    buffer = Buffer.from(dataMatch[2], "base64");
  } else if (/^https?:\/\//i.test(String(imageUrl))) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`failed to fetch input image: ${response.status}`);
    mime = (response.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("unsupported input image_url; use data:image/...;base64 or http(s) URL");
  }
  if (!mime.startsWith("image/")) throw new Error(`input image must be image/*, got ${mime}`);
  assertInputImageSize(buffer, imageUrl.slice(0, 64));
  const ext = extensionForMime(mime) || extensionFromUrl(imageUrl) || "png";
  const fileName = `${Date.now()}-${index}-${randomUUID()}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  await writeFile(filePath, buffer);
  return { path: filePath, mimeType: mime };
}

async function attachmentsFromMessages(messages) {
  const urls = imageUrlsFromMessages(messages);
  const attachments = [];
  for (let i = 0; i < urls.length; i += 1) {
    attachments.push(await materializeInputImage(urls[i], i));
  }
  return attachments;
}

function mapModel(model) {
  const m = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const explicit = {
    "gpt-5.5": "gpt-5-5",
    "gpt-5.5-pro": "gpt-5-5-pro",
    "gpt-5.5-thinking": "gpt-5-5-thinking",
    "gpt-image-2": DEFAULT_MODEL,
    "gpt-image-1": DEFAULT_MODEL,
  };
  return explicit[m] || m;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptLooksLikeImageRequest(prompt) {
  return /生成.*(图片|图像|图)|画.*(图片|图像|图)|绘图|绘画|生图|图片生成|图像生成|create\s+(an?\s+)?image|generate\s+(an?\s+)?image|draw\s+(an?\s+)?image/i.test(prompt || "");
}

function shouldCollectImages(body, prompt, result = null) {
  if (body?.return_images || body?.include_images || body?.modalities?.includes?.("image")) return true;
  if (promptLooksLikeImageRequest(prompt)) return true;
  if (result && !String(result.text || "").trim()) return true;
  return false;
}

function imageMarkdown(images) {
  return images
    .map((image, index) => `![${image.alt || `Generated image ${index + 1}`}](${image.url})`)
    .join("\n");
}

function contentWithImages(text, images) {
  const base = String(text || "").trim();
  const markdown = imageMarkdown(images);
  if (!markdown) return base;
  return base ? `${base}\n\n${markdown}` : markdown;
}

function uniqueImages(images) {
  const seen = new Set();
  const out = [];
  for (const image of images) {
    if (!image?.url || seen.has(image.url)) continue;
    seen.add(image.url);
    out.push(image);
  }
  return out;
}

async function extractGeneratedImages(Runtime) {
  const result = await Runtime.evaluate({
    expression: `(() => {
      const candidates = [];
      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        const src = img.currentSrc || img.src || "";
        const alt = img.alt || "";
        const className = String(img.className || "");
        const rect = img.getBoundingClientRect();
        const bag = [src, alt, className].join(" ");
        const uploadedSource = /\.(png|jpe?g|webp|gif)$/i.test(alt.trim()) && !/Generated image/i.test(alt);
        const generated = /Generated image|image-gen|dalle|usercontent|\/files\//i.test(bag) || (/backend-api\/estuary\/content/i.test(src) && /Generated image/i.test(alt));
        const profile = /profile image|avatar|thumbnail/i.test(alt) || /thumbnail/i.test(src);
        if (!src || !generated || profile || uploadedSource) continue;
        if (rect.width < 96 || rect.height < 96) continue;
        candidates.push({
          url: src,
          alt,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
        });
      }
      return candidates;
    })()`,
    returnByValue: true,
  });
  return Array.isArray(result.result?.value) ? uniqueImages(result.result.value) : [];
}

function extensionForMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

async function fetchImageDataUrl(Runtime, url) {
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
      if (!response.ok) throw new Error("image fetch failed: " + response.status);
      const blob = await response.blob();
      const reader = new FileReader();
      return await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value || "";
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match) throw new Error("image data url not returned");
  return { mime: match[1], b64Json: match[2] };
}

async function materializeImages(Runtime, images) {
  await mkdir(IMAGE_DIR, { recursive: true });
  const out = [];
  for (const image of images) {
    try {
      const { mime, b64Json } = await fetchImageDataUrl(Runtime, image.url);
      const ext = extensionForMime(mime);
      const fileName = `${randomUUID()}.${ext}`;
      await writeFile(path.join(IMAGE_DIR, fileName), Buffer.from(b64Json, "base64"));
      out.push({
        ...image,
        source_url: image.url,
        fileName,
        content_type: mime,
        b64_json: b64Json,
      });
    } catch (err) {
      console.error("materialize image failed:", err?.message || String(err));
      out.push({ ...image, source_url: image.url });
    }
  }
  return out;
}

async function extractGeneratedImagesFromConversation(Runtime, conversationId) {
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const conversationId = ${JSON.stringify(conversationId)};
      const sessionResp = await fetch("/api/auth/session", { credentials: "include" });
      const session = await sessionResp.json().catch(() => ({}));
      const token = session && session.accessToken;
      if (!token) return { ok: false, stage: "session", status: sessionResp.status };

      const headers = { authorization: "Bearer " + token };
      const conversationResp = await fetch("/backend-api/conversation/" + encodeURIComponent(conversationId), {
        credentials: "include",
        headers,
      });
      const conversationText = await conversationResp.text();
      let conversation = null;
      try { conversation = JSON.parse(conversationText); } catch {}
      if (!conversationResp.ok || !conversation) {
        return { ok: false, stage: "conversation", status: conversationResp.status };
      }

      const cleanPointer = (value) => String(value || "")
        .replace(/^sediment:\\/\\//, "")
        .replace(/^file-service:\\/\\//, "");
      const messages = Object.values(conversation.mapping || {})
        .map((node) => node && node.message)
        .filter(Boolean);
      const byPointer = new Map();
      for (const message of messages) {
        const parts = Array.isArray(message.content && message.content.parts) ? message.content.parts : [];
        for (const part of parts) {
          if (!part || typeof part !== "object" || !part.asset_pointer) continue;
          if (part.content_type && part.content_type !== "image_asset_pointer") continue;
          const metadata = part.metadata || {};
          const generated = message.author && message.author.role !== "user"
            && (metadata.dalle || metadata.generation || message.author.role === "tool");
          if (!generated) continue;
          const pointer = part.asset_pointer;
          if (!byPointer.has(pointer)) {
            byPointer.set(pointer, {
              pointer,
              fileId: cleanPointer(pointer),
              alt: metadata.dalle?.gen_id || metadata.generation?.gen_id || "Generated image",
              width: part.width,
              height: part.height,
              naturalWidth: part.width,
              naturalHeight: part.height,
              content_type: part.mime_type,
            });
          }
        }
      }

      const images = [];
      for (const image of byPointer.values()) {
        const params = new URLSearchParams({
          conversation_id: conversationId,
          inline: "true",
          download_intent: "false",
        });
        const linkResp = await fetch("/backend-api/files/download/" + encodeURIComponent(image.fileId) + "?" + params.toString(), {
          credentials: "include",
          headers,
        });
        const linkText = await linkResp.text();
        let link = null;
        try { link = JSON.parse(linkText); } catch {}
        if (!linkResp.ok || !link || link.status !== "success" || !link.download_url) continue;
        images.push({
          url: link.download_url,
          alt: image.alt,
          width: image.width,
          height: image.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          content_type: link.mime_type || image.content_type,
        });
      }
      return { ok: true, images };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || "conversation image extraction failed";
    throw new Error(text);
  }
  const value = result.result?.value;
  if (!value?.ok) {
    if (value) console.error("conversation image extraction skipped:", JSON.stringify(value));
    return [];
  }
  return uniqueImages(Array.isArray(value.images) ? value.images : []);
}

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function presentImages(req, images, { includeB64 = false } = {}) {
  const base = publicBaseUrl(req);
  return images.map((image) => {
    const publicUrl = image.fileName ? `${base}/v1/rosetta/images/${encodeURIComponent(image.fileName)}` : image.url;
    const presented = {
      url: publicUrl,
      source_url: image.source_url || image.url,
      alt: image.alt || "",
      width: image.width,
      height: image.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      content_type: image.content_type,
    };
    if (includeB64 && image.b64_json) presented.b64_json = image.b64_json;
    return presented;
  });
}

async function collectGeneratedImages(conversationId, { timeoutMs = 90000 } = {}) {
  if (!conversationId) return [];
  let client;
  let targetId;
  try {
    const url = `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
    const target = await CDP.New({ host: CDP_HOST, port: CDP_PORT, url });
    targetId = target.id;
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const { Page, Runtime } = client;
    await Runtime.enable();
    await Page.enable();
    await sleep(2500);

    const conversationImages = await extractGeneratedImagesFromConversation(Runtime, conversationId);
    if (conversationImages.length > 0) return await materializeImages(Runtime, conversationImages);

    const deadline = Date.now() + timeoutMs;
    let images = [];
    while (Date.now() < deadline) {
      images = await extractGeneratedImages(Runtime);
      if (images.length > 0) return await materializeImages(Runtime, images);
      await sleep(1000);
    }
    const lateConversationImages = await extractGeneratedImagesFromConversation(Runtime, conversationId);
    if (lateConversationImages.length > 0) return await materializeImages(Runtime, lateConversationImages);
    return images.length ? await materializeImages(Runtime, images) : images;
  } catch (err) {
    console.error("collectGeneratedImages failed:", err?.message || String(err));
    return [];
  } finally {
    try { await client?.close?.(); } catch {}
    try { if (targetId) await CDP.Close({ host: CDP_HOST, port: CDP_PORT, id: targetId }); } catch {}
  }
}

async function cdpVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, { signal: controller.signal });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeRosettaAuth() {
  let session;
  try {
    session = await openSession({ host: CDP_HOST, port: CDP_PORT });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || undefined };
  } finally {
    try { await session?.close?.(); } catch {}
  }
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleChat(req, res) {
  if (!checkAuth(req)) return sendJson(res, 401, openaiError("Unauthorized", "invalid_request_error", "unauthorized"));
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, openaiError(err.message, "invalid_request_error", "bad_request"));
  }

  const model = mapModel(body.model);
  const prompt = body.prompt || messagesToPrompt(body.messages);
  if (!prompt) return sendJson(res, 400, openaiError("messages or prompt is required", "invalid_request_error", "bad_request"));
  let attachments = [];
  try {
    attachments = await attachmentsFromMessages(body.messages);
  } catch (err) {
    return sendJson(res, 400, openaiError(err?.message || String(err), "invalid_request_error", "bad_request"));
  }
  const requestedEffort = body.thinking_effort ?? body.thinkingEffort;
  const thinkingEffort = requestedEffort ?? (/-pro$/.test(model) ? "standard" : undefined);
  const runInput = { prompt, model };
  if (thinkingEffort !== undefined) runInput.thinkingEffort = thinkingEffort;
  if (attachments.length) runInput.attachments = attachments;
  const collectImagesForRequest = shouldCollectImages(body, prompt) || attachments.length > 0;

  let session;
  const id = `chatcmpl-rosetta-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  try {
    session = await openSession({ host: CDP_HOST, port: CDP_PORT });
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      writeSse(res, { id, object: "chat.completion.chunk", created, model: body.model || model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const result = await runConversation(session, runInput, {
        timeoutMs: Number(body.timeout_ms || 20 * 60 * 1000),
        idleTimeoutMs: Number(body.idle_timeout_ms || 5 * 60 * 1000),
        keepConversation: collectImagesForRequest,
        onChunk: (delta) => {
          if (!delta) return;
          writeSse(res, { id, object: "chat.completion.chunk", created, model: body.model || model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
        },
      });
      if (!collectImagesForRequest) { try { await session?.close?.(); session = null; } catch {} }
      const rawImages = (collectImagesForRequest || shouldCollectImages(body, prompt, result)) ? await collectGeneratedImages(result.conversationId) : [];
      const images = presentImages(req, rawImages);
      const markdown = imageMarkdown(images);
      if (markdown) {
        writeSse(res, { id, object: "chat.completion.chunk", created, model: body.model || result.modelSlug || model, choices: [{ index: 0, delta: { content: markdown }, finish_reason: null }], rosetta: { images } });
      }
      writeSse(res, { id, object: "chat.completion.chunk", created, model: body.model || result.modelSlug || model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const result = await runConversation(session, runInput, {
      timeoutMs: Number(body.timeout_ms || 20 * 60 * 1000),
      idleTimeoutMs: Number(body.idle_timeout_ms || 5 * 60 * 1000),
      keepConversation: collectImagesForRequest,
    });
    if (!collectImagesForRequest) { try { await session?.close?.(); session = null; } catch {} }
    const rawImages = (collectImagesForRequest || shouldCollectImages(body, prompt, result)) ? await collectGeneratedImages(result.conversationId) : [];
    const images = presentImages(req, rawImages, { includeB64: body.response_format === "b64_json" });
    const content = contentWithImages(result.text, images);
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: body.model || result.modelSlug || model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      images,
      rosetta: { modelSlug: result.modelSlug, conversationId: result.conversationId, messageId: result.messageId, tookMs: result.tookMs, images, inputImages: attachments.length },
    });
  } catch (err) {
    const status = err instanceof RosettaAuthError || String(err?.message || err).includes("not logged in") ? 503 : 502;
    return sendJson(res, status, openaiError(err?.message || String(err), status === 503 ? "auth_error" : "upstream_error", status === 503 ? "not_logged_in" : "upstream_error"));
  } finally {
    try { await session?.close?.(); } catch {}
  }
}

async function handleImageGeneration(req, res) {
  if (!checkAuth(req)) return sendJson(res, 401, openaiError("Unauthorized", "invalid_request_error", "unauthorized"));
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, openaiError(err.message, "invalid_request_error", "bad_request"));
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return sendJson(res, 400, openaiError("prompt is required", "invalid_request_error", "bad_request"));

  const model = mapModel(body.model || DEFAULT_MODEL);
  const imagePrompt = `请根据下面提示生成一张图片。生成后不要解释，只生成图片。\\n\\n${prompt}`;
  let session;
  try {
    session = await openSession({ host: CDP_HOST, port: CDP_PORT });
    const result = await runConversation(session, { prompt: imagePrompt, model }, {
      timeoutMs: Number(body.timeout_ms || 20 * 60 * 1000),
      idleTimeoutMs: Number(body.idle_timeout_ms || 5 * 60 * 1000),
      keepConversation: true,
    });
    try { await session?.close?.(); session = null; } catch {}
    const rawImages = await collectGeneratedImages(result.conversationId);
    const images = presentImages(req, rawImages, { includeB64: body.response_format === "b64_json" });
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: images.map((image) => ({
        ...(body.response_format === "b64_json" && image.b64_json ? { b64_json: image.b64_json } : { url: image.url }),
        revised_prompt: image.alt || prompt,
        width: image.width,
        height: image.height,
      })),
      rosetta: { modelSlug: result.modelSlug, conversationId: result.conversationId, messageId: result.messageId, tookMs: result.tookMs, images, inputImages: 0 },
    });
  } catch (err) {
    const status = err instanceof RosettaAuthError || String(err?.message || err).includes("not logged in") ? 503 : 502;
    return sendJson(res, status, openaiError(err?.message || String(err), status === 503 ? "auth_error" : "upstream_error", status === 503 ? "not_logged_in" : "upstream_error"));
  } finally {
    try { await session?.close?.(); } catch {}
  }
}

async function handleStoredImage(req, res, url) {
  const fileName = decodeURIComponent(url.pathname.slice("/v1/rosetta/images/".length));
  if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)$/i.test(fileName)) {
    return sendJson(res, 400, openaiError("Bad image id", "invalid_request_error", "bad_image_id"));
  }
  try {
    const filePath = path.join(IMAGE_DIR, fileName);
    const data = await readFile(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".webp" ? "image/webp" :
      ext === ".gif" ? "image/gif" : "image/png";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": data.length,
      "cache-control": "public, max-age=604800, immutable",
    });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  } catch {
    return sendJson(res, 404, openaiError("Image not found", "invalid_request_error", "image_not_found"));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/v1/rosetta/images/")) return handleStoredImage(req, res, url);
  if (req.method === "GET" && url.pathname === "/health") {
    const cdp = await cdpVersion();
    const auth = cdp.ok ? await probeRosettaAuth() : { ok: false, error: "cdp unavailable" };
    return sendJson(res, 200, { status: cdp.ok ? "ok" : "starting", cdp, auth });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!checkAuth(req)) return sendJson(res, 401, openaiError("Unauthorized", "invalid_request_error", "unauthorized"));
    return sendJson(res, 200, { object: "list", data: exposedModels.map((id) => ({ id, object: "model", created: 0, owned_by: "rosetta", root: id, parent: null })) });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChat(req, res);
  if (req.method === "POST" && url.pathname === "/v1/images/generations") return handleImageGeneration(req, res);
  return sendJson(res, 404, openaiError("Not found", "invalid_request_error", "not_found"));
});

server.listen(PORT, HOST, () => {
  console.log(`rosetta-openai wrapper listening on http://${HOST}:${PORT}`);
  console.log(`CDP target: ${CDP_HOST}:${CDP_PORT}`);
});
