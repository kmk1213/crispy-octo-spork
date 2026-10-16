"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { buildWorkbook, downloadWorkbook } = require("../web/xlsx.js");

const fixture = [
  {
    name: "추천 상품 🇰🇷",
    rows: [
      ["상품", "예상 이익", "빈 값", "판매 가능", "문자열 안전성"],
      ["라운드랩 <독도> & 크림", 1234.567, null, true, '=HYPERLINK("https://example.com","클릭")'],
      ["베트남 Tiếng Việt / 필리핀", -42.5, null, false, "+SUM(A1:A2)"],
      ["  공백\t유지\n줄바꿈  ", 0, "", null, "위험\u0000문자\u0007제거"],
      ["줄바꿈\r\n원문 유지", 1e-7],
    ],
  },
  { name: "비교 / 수익", rows: [["최저가", "배송비"], [9900, 3000]] },
  { name: "비교 / 수익", rows: [] },
];

const workbook = buildWorkbook(fixture);
assert.ok(workbook instanceof Uint8Array);
fs.writeFileSync("/tmp/web-xlsx-test.xlsx", workbook);
const buffer = Buffer.from(workbook);
const entries = new Map();
let position = 0;
function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
while (buffer.readUInt32LE(position) === 0x04034b50) {
  const size = buffer.readUInt32LE(position + 18);
  const nameLength = buffer.readUInt16LE(position + 26);
  const extraLength = buffer.readUInt16LE(position + 28);
  const name = buffer.subarray(position + 30, position + 30 + nameLength).toString("utf8");
  const start = position + 30 + nameLength + extraLength;
  const bytes = buffer.subarray(start, start + size);
  assert.equal(buffer.readUInt16LE(position + 8), 0, "ZIP entries use the stored compression method");
  assert.equal(buffer.readUInt32LE(position + 14), checksum(bytes), `CRC32 matches ${name}`);
  entries.set(name, { position, size, crc: checksum(bytes), text: bytes.toString("utf8") });
  position = start + size;
}
const centralStart = position;
let centralCount = 0;
while (buffer.readUInt32LE(position) === 0x02014b50) {
  const nameLength = buffer.readUInt16LE(position + 28);
  const name = buffer.subarray(position + 46, position + 46 + nameLength).toString("utf8");
  const entry = entries.get(name);
  assert.ok(entry, "Central directory points to a local entry");
  assert.equal(buffer.readUInt32LE(position + 42), entry.position);
  assert.equal(buffer.readUInt32LE(position + 16), entry.crc);
  assert.equal(buffer.readUInt32LE(position + 20), entry.size);
  position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  centralCount += 1;
}
assert.equal(buffer.readUInt32LE(position), 0x06054b50);
assert.equal(buffer.readUInt16LE(position + 10), entries.size);
assert.equal(centralCount, entries.size);
assert.equal(buffer.readUInt32LE(position + 12), position - centralStart);
assert.equal(buffer.readUInt32LE(position + 16), centralStart);
assert.equal(position + 22, buffer.length);
assert.ok(entries.has("[Content_Types].xml"));
const sheet = entries.get("xl/worksheets/sheet1.xml").text;
assert.ok(sheet.includes("&lt;독도&gt; &amp;"));
assert.ok(sheet.includes('t="inlineStr"'));
assert.ok(!sheet.includes("<f>"), "User text cannot become an Excel formula");
assert.ok(!sheet.includes("\u0000") && !sheet.includes("\u0007"));
assert.ok(sheet.includes('r="D2" t="b"'));
assert.ok(sheet.includes('r="B2"><v>1234.567</v>'));
assert.ok(!sheet.includes('r="C2"'), "Null cells keep the column position but have no value");
assert.ok(entries.get("xl/workbook.xml").text.includes("비교   수익 (2)"));

assert.throws(() => buildWorkbook([]), /At least one/);
assert.throws(() => buildWorkbook([{ name: "bad", rows: [[NaN]] }]), /finite/);
assert.throws(() => buildWorkbook([{ name: "bad", rows: [[{}]] }]), /Cell values/);
assert.throws(() => buildWorkbook([{ name: "bad", rows: [["x".repeat(32768)]] }]), /32,767/);
assert.throws(() => buildWorkbook([{ name: "bad", rows: [Array(16385).fill(null)] }]), /16,384/);
assert.throws(() => downloadWorkbook("test.xlsx", fixture), /requires a browser/);

const events = [];
let browserBlob;
const link = {
  style: {},
  click() { events.push("click"); },
  remove() { events.push("remove"); },
};
const browser = {
  TextEncoder, Uint8Array, Uint32Array, DataView, Set, Blob,
  document: {
    createElement(tag) { assert.equal(tag, "a"); return link; },
    body: { appendChild(element) { assert.equal(element, link); events.push("append"); } },
  },
  URL: {
    createObjectURL(blob) { browserBlob = blob; events.push("create"); return "blob:test"; },
    revokeObjectURL(url) { assert.equal(url, "blob:test"); events.push("revoke"); },
  },
  setTimeout(callback, delay) { assert.equal(delay, 1000); events.push("scheduled"); callback(); },
};
vm.createContext(browser);
vm.runInContext(fs.readFileSync(require.resolve("../web/xlsx.js"), "utf8"), browser);
assert.equal(typeof browser.SourcingXlsx.buildWorkbook, "function");
browser.SourcingXlsx.downloadWorkbook("추천 결과", fixture);
assert.equal(link.download, "추천 결과.xlsx");
assert.equal(link.href, "blob:test");
assert.equal(browserBlob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
assert.deepEqual(events, ["create", "append", "click", "remove", "scheduled", "revoke"]);

console.log("XLSX ZIP, cell safety, validation, and browser download checks passed.");
console.log("Generated /tmp/web-xlsx-test.xlsx for openpyxl compatibility validation.");
