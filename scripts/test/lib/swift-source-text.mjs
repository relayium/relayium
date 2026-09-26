// Match Swift String source guards by whole, canonically equivalent Characters.
// Plain JS includes/split would also match an ASCII delimiter with a combining
// mark attached, which the original XCTest guards reject.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const characters = text => Array.from(segmenter.segment(text), x => x.segment.normalize('NFC'));
function find(haystack, needle, start = 0) {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    if (needle.every((character, j) => haystack[i + j] === character)) return i;
  }
  return -1;
}
export function containsText(text, needle) {
  return find(characters(text), characters(needle)) >= 0;
}
export function splitText(text, delimiter) {
  const source = characters(text), boundary = characters(delimiter);
  if (!boundary.length) throw new Error('source guards require a nonempty delimiter');
  const parts = [];
  let start = 0, index;
  while ((index = find(source, boundary, start)) >= 0) {
    parts.push(source.slice(start, index).join(''));
    start = index + boundary.length;
  }
  parts.push(source.slice(start).join(''));
  return parts;
}
