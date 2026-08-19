// Unit tests for the VTT / SRT parsing logic mirroring src/content/index.ts
// Run: node scripts/test-parsers.mjs

function parseVtt(text) {
  const segments = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const m = block.match(
      /(\d{2}:)?(\d{2}):(\d{2})\.\d+\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})\.\d+(.*)/s,
    );
    if (!m) { continue; }
    const start =
      parseInt(m[1] ?? '0', 10) * 3600 +
      parseInt(m[2], 10) * 60 +
      parseInt(m[3], 10);
    const t = m[7]
      .replace(/<\/?[^>]+>/g, '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (t) segments.push({ start, text: t });
  }
  return segments;
}

function parseSrt(text) {
  const segments = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const m = block.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d+)([\s\S]*)/,
    );
    if (!m) continue;
    const start = m[1]
      .replace(',', '.')
      .split(':')
      .reduce((acc, p, i) => acc + parseFloat(p) * ([3600, 60, 1][i] ?? 0), 0);
    const t = m[3]
      .replace(/<\/?[^>]+>/g, '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (t) segments.push({ start, text: t });
  }
  return segments;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

// VTT: short form (mm:ss.ss)
const vttShort = `WEBVTT

1
00:01.200 --> 00:03.500
Hello world

2
01:30.000 --> 01:32.000
<b>Bold</b> caption
line two`;

const v1 = parseVtt(vttShort);
assert(v1.length === 2, 'VTT short form parses 2 segments');
assert(v1[0].start === 1, 'VTT short start=1s');
assert(v1[1].start === 90, 'VTT short start=90s');
assert(v1[1].text === 'Bold caption line two', 'VTT strips tags and joins lines');

// VTT: long form (hh:mm:ss.ss)
const vttLong = `WEBVTT

1
01:23:45.678 --> 01:24:00.000
Long form caption`;
const v2 = parseVtt(vttLong);
assert(v2.length === 1, 'VTT long form parses');
assert(v2[0].start === 1 * 3600 + 23 * 60 + 45, 'VTT long start=5025s');

// SRT
const srt = `1
00:00:02,000 --> 00:00:05,500
First subtitle

2
01:02:03,400 --> 01:02:10,000
<i>Second</i>
subtitle`;

const s1 = parseSrt(srt);
assert(s1.length === 2, 'SRT parses 2 segments');
assert(Math.abs(s1[0].start - 2) < 0.001, 'SRT start=2s');
assert(Math.abs(s1[1].start - (3600 + 120 + 3.4)) < 0.001, 'SRT start=3723.4s');
assert(s1[1].text === 'Second subtitle', 'SRT strips tags and joins lines');

// YouTube JSON3-style reduction (same reduce used for SRT start calc)
assert(
  ['1', '2', '3.4'].reduce((a, p, i) => a + parseFloat(p) * ([3600, 60, 1][i] ?? 0), 0) ===
    3600 + 120 + 3.4,
  'hour reduce math matches parseSrt',
);

console.log('\nAll parser tests passed.');
