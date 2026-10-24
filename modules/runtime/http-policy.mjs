/* Loopback bridge parsing and constant-time credential comparison. */
import { timingSafeEqual } from "node:crypto";
export async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw new Error("JSON content type required.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new Error("Request exceeds 6 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export const equal = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
