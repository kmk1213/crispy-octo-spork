/* Dependency-free Excel export. All text is stored as text, including = formulas. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SourcingXlsx = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  var MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  var encoder = new TextEncoder();
  var crcTable = new Uint32Array(256);
  for (var n = 0; n < 256; n += 1) {
    var crc = n;
    for (var bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    crcTable[n] = crc >>> 0;
  }

  function crc32(bytes) {
    var result = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) result = (result >>> 8) ^ crcTable[(result ^ bytes[i]) & 255];
    return (result ^ 0xffffffff) >>> 0;
  }

  function cleanText(value) {
    // XML 1.0 disallows these code points; replace unpaired UTF-16 surrogates too.
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, function (match, prefix) {
        return (prefix || "") + "\ufffd";
      });
  }

  function escapeXml(value) {
    return cleanText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
      .replace(/\r/g, "&#13;");
  }

  function columnName(index) {
    var name = "";
    for (var number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
      name = String.fromCharCode(65 + (number - 1) % 26) + name;
    }
    return name;
  }

  function uniqueSheetName(value, index, used) {
    var base = cleanText(value == null ? "Sheet" + (index + 1) : value)
      .replace(/[\\/?:*\[\]\t\r\n]/g, " ").replace(/^'+|'+$/g, "").trim() || "Sheet" + (index + 1);
    // Array.from keeps supplementary Unicode characters intact when truncating.
    function truncate(text, length) {
      var result = "";
      for (var character of text) {
        if (result.length + character.length > length) break;
        result += character;
      }
      return result;
    }
    var name = truncate(base, 31);
    var suffix = 1;
    while (used.has(name.toLowerCase())) {
      var ending = " (" + (++suffix) + ")";
      name = truncate(base, 31 - ending.length) + ending;
    }
    used.add(name.toLowerCase());
    return name;
  }

  function sheetXml(rows) {
    if (!Array.isArray(rows)) throw new TypeError("Each sheet must have a rows array.");
    if (rows.length > 1048576) throw new RangeError("Excel supports at most 1,048,576 rows per sheet.");
    var maxColumns = 0;
    var data = rows.map(function (row, rowIndex) {
      if (!Array.isArray(row)) throw new TypeError("Each row must be an array.");
      if (row.length > 16384) throw new RangeError("Excel supports at most 16,384 columns per sheet.");
      maxColumns = Math.max(maxColumns, row.length);
      var cells = row.map(function (value, columnIndex) {
        if (value == null) return "";
        var reference = columnName(columnIndex) + (rowIndex + 1);
        var style = rowIndex === 0 ? ' s="1"' : "";
        if (typeof value === "number") {
          if (!Number.isFinite(value)) throw new TypeError("Excel numeric cells must be finite.");
          return '<c r="' + reference + '"' + style + '><v>' + String(value) + '</v></c>';
        }
        if (typeof value === "boolean") {
          return '<c r="' + reference + '" t="b"' + style + '><v>' + (value ? "1" : "0") + '</v></c>';
        }
        if (typeof value !== "string") throw new TypeError("Cell values must be strings, numbers, booleans, or null.");
        var text = cleanText(value);
        if (text.length > 32767) throw new RangeError("Excel text cells support at most 32,767 characters.");
        // Escape OOXML's own encoded-character syntax before XML entity escaping.
        text = text.replace(/_x[0-9a-f]{4}_/gi, function (match) { return "_x005F_" + match.slice(1); });
        // Inline strings never execute spreadsheet formulas or DDE payloads.
        return '<c r="' + reference + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' +
          escapeXml(text) + '</t></is></c>';
      }).join("");
      return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
    }).join("");
    var dimension = rows.length && maxColumns ? 'A1:' + columnName(maxColumns - 1) + rows.length : "A1";
    return XML + '<worksheet xmlns="' + NS + '"><dimension ref="' + dimension + '"/>' +
      '<sheetViews><sheetView workbookViewId="0">' +
      (rows.length ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "") +
      '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>' + data + '</sheetData></worksheet>';
  }

  function zip(files) {
    var entries = files.map(function (file) {
      var name = encoder.encode(file.name);
      var bytes = encoder.encode(file.text);
      return { name: name, bytes: bytes, crc: crc32(bytes), offset: 0 };
    });
    var localLength = 0;
    var centralLength = 0;
    entries.forEach(function (entry) {
      entry.offset = localLength;
      localLength += 30 + entry.name.length + entry.bytes.length;
      centralLength += 46 + entry.name.length;
    });
    var length = localLength + centralLength + 22;
    if (length > 0xffffffff || entries.length > 65535) throw new RangeError("Workbook is too large for ZIP export.");
    var output = new Uint8Array(length);
    var view = new DataView(output.buffer);
    var position = 0;
    function u16(value) { view.setUint16(position, value, true); position += 2; }
    function u32(value) { view.setUint32(position, value, true); position += 4; }
    function bytes(value) { output.set(value, position); position += value.length; }
    entries.forEach(function (entry) {
      u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0x0021);
      u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length); u16(entry.name.length); u16(0);
      bytes(entry.name); bytes(entry.bytes);
    });
    entries.forEach(function (entry) {
      u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0x0021);
      u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length); u16(entry.name.length);
      u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset); bytes(entry.name);
    });
    u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
    u32(centralLength); u32(localLength); u16(0);
    return output;
  }

  /** Build a genuine .xlsx file. Invalid/duplicate sheet names are normalized. */
  function buildWorkbook(sheets) {
    if (!Array.isArray(sheets) || !sheets.length) throw new TypeError("At least one worksheet is required.");
    var used = new Set();
    var files = [];
    var worksheetEntries = [];
    var relationships = [];
    var overrides = [];
    sheets.forEach(function (sheet, index) {
      if (!sheet || typeof sheet !== "object") throw new TypeError("Each sheet must be an object with name and rows.");
      var id = index + 1;
      var name = uniqueSheetName(sheet.name, index, used);
      worksheetEntries.push('<sheet name="' + escapeXml(name) + '" sheetId="' + id + '" r:id="rId' + id + '"/>');
      relationships.push('<Relationship Id="rId' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + id + '.xml"/>');
      overrides.push('<Override PartName="/xl/worksheets/sheet' + id + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
      files.push({ name: "xl/worksheets/sheet" + id + ".xml", text: sheetXml(sheet.rows) });
    });
    relationships.push('<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    files.push({ name: "[Content_Types].xml", text: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + overrides.join("") + '</Types>' });
    files.push({ name: "_rels/.rels", text: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: "xl/workbook.xml", text: XML + '<workbook xmlns="' + NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView/></bookViews><sheets>' + worksheetEntries.join("") + '</sheets></workbook>' });
    files.push({ name: "xl/_rels/workbook.xml.rels", text: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + relationships.join("") + '</Relationships>' });
    files.push({ name: "xl/styles.xml", text: XML + '<styleSheet xmlns="' + NS + '">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
    return zip(files);
  }

  /** Download in a browser; no server, CDN, account, or installation is needed. */
  function downloadWorkbook(filename, sheets) {
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new Error("Workbook download requires a browser. Use buildWorkbook in Node.js.");
    }
    var name = String(filename || "sourcing-report.xlsx");
    if (!/\.xlsx$/i.test(name)) name += ".xlsx";
    var blob = new Blob([buildWorkbook(sheets)], { type: MIME });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    try {
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      // Allow the browser to start reading the object URL before revoking it.
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  return { buildWorkbook: buildWorkbook, downloadWorkbook: downloadWorkbook };
});
