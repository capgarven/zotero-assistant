import { deflateRawSync, deflateSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonDir = join(root, "addon");
const manifest = JSON.parse(readFileSync(join(addonDir, "manifest.json"), "utf8"));
const outDir = join(root, "dist");
const outFile = join(outDir, `zotero-assistant-${manifest.version}.xpi`);

function crc32(buffer) {
  let crc = ~0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zip(files) {
  const stamp = dosTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const payload = compressed.length < file.data.length ? compressed : file.data;
    const method = payload === compressed ? 8 : 0;
    const checksum = crc32(file.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(method),
      u16(stamp.time),
      u16(stamp.day),
      u32(checksum),
      u32(payload.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      payload,
    ]);
    parts.push(local);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x800),
        u16(method),
        u16(stamp.time),
        u16(stamp.day),
        u32(checksum),
        u32(payload.length),
        u32(file.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...parts, directory, end]);
}

function inRoundRect(x, y, left, top, width, height, radius) {
  const right = left + width - 1;
  const bottom = top + height - 1;
  if (x < left || y < top || x > right || y > bottom) return false;
  const centers = [
    [left + radius, top + radius],
    [right - radius, top + radius],
    [left + radius, bottom - radius],
    [right - radius, bottom - radius],
  ];
  const inCorner =
    (x < left + radius && y < top + radius) ||
    (x > right - radius && y < top + radius) ||
    (x < left + radius && y > bottom - radius) ||
    (x > right - radius && y > bottom - radius);
  if (!inCorner) return true;
  return centers.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2);
}

function drawIcon(size) {
  const data = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    const alpha = a / 255;
    const inverse = 1 - alpha;
    data[offset] = Math.round(r * alpha + data[offset] * inverse);
    data[offset + 1] = Math.round(g * alpha + data[offset + 1] * inverse);
    data[offset + 2] = Math.round(b * alpha + data[offset + 2] * inverse);
    data[offset + 3] = Math.round(a + data[offset + 3] * inverse);
  };
  const radius = Math.round(size * 0.22);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inRoundRect(x, y, 0, 0, size, size, radius)) put(x, y, 28, 25, 23);
    }
  }
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const arm = size * 0.34;
  const waist = Math.max(1.2, size * 0.075);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const diamond = dx / arm + dy / arm <= 1;
      const cross = dx <= waist || dy <= waist;
      if (diamond && (cross || dx + dy < arm * 0.72)) put(x, y, 244, 239, 228);
    }
  }
  return data;
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.concat([
    u32(width),
    u32(height),
    Buffer.from([8, 6, 0, 0, 0]),
  ]);
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
  };
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIcons() {
  const dir = join(addonDir, "content", "icons");
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 48, 96]) {
    if (size === 16) continue;
    writeFileSync(join(dir, `icon${size}.png`), encodePNG(size, size, drawIcon(size)));
  }
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (![".DS_Store", "Thumbs.db"].includes(entry.name)) files.push(full);
  }
  return files;
}

writeIcons();
const required = [
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "content/pane.css",
  "content/preferences.xhtml",
  "content/scripts/util.js",
  "content/scripts/context.js",
  "content/scripts/ai.js",
  "content/scripts/notes.js",
  "content/scripts/pane.js",
  "content/scripts/prefsPane.js",
  "content/scripts/main.js",
  "content/icons/icon48.png",
  "content/icons/icon96.png",
  "content/icons/pane-16.svg",
  "content/icons/pane-20.svg",
  "locale/zh-CN/zotero-assistant.ftl",
  "locale/en-US/zotero-assistant.ftl",
];
const files = walk(addonDir).map((full) => ({
  name: relative(addonDir, full).split(sep).join("/"),
  data: readFileSync(full),
}));
const names = new Set(files.map((file) => file.name));
const missing = required.filter((name) => !names.has(name));
if (missing.length) {
  throw new Error(`插件包缺少文件：${missing.join(", ")}`);
}
const zoteroApp = manifest.applications.zotero;
if (zoteroApp.strict_min_version !== "10.0") {
  throw new Error("manifest 的最低版本必须是 Zotero 10.0");
}
if (!/^https:\/\/\S+$/.test(zoteroApp.update_url || "")) {
  throw new Error("Zotero 10 要求 applications.zotero.update_url 为 https 地址，否则安装会被拒绝");
}
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, zip(files));
if (!statSync(outFile).size) throw new Error("XPI 没有写出来");
console.log(outFile);
