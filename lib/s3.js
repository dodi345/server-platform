// @ts-check
// Klien S3 minimal (AWS Signature V4) untuk Cloudflare R2: put, get, list, delete.
// Tanpa dependency. Path-style: https://<akun>.r2.cloudflarestorage.com/<bucket>/<key>.
// Secret tidak pernah masuk pesan error.
import crypto from "node:crypto";

export class S3Error extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string | null} code
   */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {object} S3Config
 * @property {string} endpoint mis. https://<account-id>.r2.cloudflarestorage.com
 * @property {string} bucket
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [region] R2: "auto"
 */

/** @param {string | Buffer} data */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
/**
 * @param {string | Buffer} key
 * @param {string} data
 */
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** URI encode ala AWS: semua kecuali A-Z a-z 0-9 - _ . ~ (dan "/" untuk path). */
export function awsEncode(/** @type {string} */ value, keepSlash = false) {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) return ch;
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** @param {Date} date */
const amzDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Tanda tangan SigV4 untuk satu permintaan.
 * @param {{ method: string, host: string, path: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string, accessKeyId: string, secretAccessKey: string, region: string, service?: string, date: Date }} req
 * @returns {Record<string, string>} header yang harus dikirim (termasuk Authorization)
 */
export function signV4(req) {
  const service = req.service ?? "s3";
  const stamp = amzDate(req.date);
  const day = stamp.slice(0, 8);
  /** @type {Record<string, string>} */
  const headers = {
    ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: req.host,
    "x-amz-content-sha256": req.payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(req.query)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(req.query[k] ?? "")}`)
    .join("&");
  const canonicalRequest = [req.method, req.path, canonicalQuery, canonicalHeaders, signedHeaders, req.payloadHash].join("\n");
  const scope = `${day}/${req.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${req.secretAccessKey}`, day), req.region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** @param {string} xml @param {string} tag */
const xmlValue = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(/** @type {string} */ (m[1])) : null;
};
/** @param {string} text */
const decodeXml = (text) =>
  text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/**
 * @param {S3Config} config
 * @param {{ fetch?: typeof fetch, now?: () => Date, timeoutMs?: number }} [deps]
 */
export function createS3(config, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const endpoint = new URL(config.endpoint);
  const region = config.region ?? "auto";
  const secrets = [config.secretAccessKey];

  /** @param {string} message */
  const hide = (message) => secrets.reduce((m, s) => (s ? m.split(s).join("<rahasia>") : m), message);

  /**
   * @param {string} method
   * @param {string} key "" = bucket
   * @param {{ query?: Record<string, string>, body?: Buffer, headers?: Record<string, string> }} [opts]
   */
  async function request(method, key, opts = {}) {
    const body = opts.body ?? Buffer.alloc(0);
    const path = `/${awsEncode(config.bucket)}${key ? `/${awsEncode(key, true)}` : ""}`;
    const query = opts.query ?? {};
    const signed = signV4({
      method,
      host: endpoint.host,
      path,
      query,
      headers: opts.headers ?? {},
      payloadHash: sha256(body),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region,
      date: now(),
    });
    const search = Object.keys(query)
      .sort()
      .map((k) => `${awsEncode(k)}=${awsEncode(query[k] ?? "")}`)
      .join("&");
    const url = `${endpoint.origin}${path}${search ? `?${search}` : ""}`;
    const { host: _host, ...headers } = signed;
    let res;
    try {
      res = await fetchFn(url, {
        method,
        headers,
        body: method === "PUT" ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new S3Error(`R2 tidak bisa dihubungi: ${hide(error instanceof Error ? error.message : String(error))}`, 0, null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = xmlValue(text, "Code");
      const message = xmlValue(text, "Message");
      throw new S3Error(`R2 menolak ${method} (${res.status}${code ? ` ${code}` : ""})${message ? `: ${hide(message)}` : ""}`, res.status, code);
    }
    return res;
  }

  return {
    /**
     * Unggah satu objek. Content-MD5 membuat R2 menolak isi yang rusak di jalan.
     * @param {string} key
     * @param {Buffer} body
     * @param {string} [contentType]
     */
    async putObject(key, body, contentType = "application/octet-stream") {
      const md5 = crypto.createHash("md5").update(body).digest("base64");
      await request("PUT", key, { body, headers: { "content-type": contentType, "content-md5": md5 } });
    },

    /** @param {string} key */
    async getObject(key) {
      const res = await request("GET", key);
      return Buffer.from(await res.arrayBuffer());
    },

    /** @param {string} key */
    async deleteObject(key) {
      await request("DELETE", key);
    },

    /** Buat bucket (hanya dipakai test dengan MinIO; di R2 bucket dibuat dari dashboard). */
    async createBucket() {
      await request("PUT", "");
    },

    /**
     * Semua objek dengan awalan ini (mengikuti halaman ListObjectsV2).
     * @param {string} prefix
     * @returns {Promise<{ key: string, size: number, lastModified: string }[]>}
     */
    async listObjects(prefix) {
      /** @type {{ key: string, size: number, lastModified: string }[]} */
      const out = [];
      /** @type {string | null} */
      let token = null;
      for (let page = 0; page < 100; page += 1) {
        /** @type {Record<string, string>} */
        const query = { "list-type": "2", prefix, "max-keys": "1000" };
        if (token) query["continuation-token"] = token;
        const xml = await (await request("GET", "", { query })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const block = /** @type {string} */ (m[1]);
          out.push({
            key: xmlValue(block, "Key") ?? "",
            size: Number(xmlValue(block, "Size") ?? 0),
            lastModified: xmlValue(block, "LastModified") ?? "",
          });
        }
        token = xmlValue(xml, "IsTruncated") === "true" ? xmlValue(xml, "NextContinuationToken") : null;
        if (!token) break;
      }
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createS3>} S3Client */
