/**
 * Code-point-safe text chunker for Discord embed descriptions.
 * Splits on paragraph boundaries (\n\n), then line boundaries (\n), then word
 * boundaries, then individual code-points as a last resort — ensuring no chunk
 * exceeds `maxChars` and no surrogate pair is split.
 */

const hardSplitCodePoints = (text: string, maxChars: number): ReadonlyArray<string> => {
  const codePoints = Array.from(text);
  const chunks: Array<string> = [];
  let start = 0;
  while (start < codePoints.length) {
    const slice = codePoints.slice(start, start + maxChars).join('');
    chunks.push(slice);
    start += maxChars;
  }
  return chunks;
};

const splitLongLine = (line: string, maxChars: number): ReadonlyArray<string> => {
  if (line.length <= maxChars) return [line];

  // Try word-boundary split first
  const words = line.split(' ');
  const result: Array<string> = [];
  let current = '';

  for (const word of words) {
    if (word.length > maxChars) {
      // Word itself exceeds maxChars — flush current, then hard-split the word
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
      for (const piece of hardSplitCodePoints(word, maxChars)) {
        result.push(piece);
      }
    } else if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      result.push(current);
      current = word;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
};

export const chunkForEmbedDescription = (text: string, maxChars = 4096): ReadonlyArray<string> => {
  if (text.length === 0) return [''];

  const paragraphs = text.split('\n\n');
  const chunks: Array<string> = [];
  let current = '';

  const flushCurrent = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const paragraph = paragraphs[pi];
    const paragraphSeparator = pi > 0 ? '\n\n' : '';
    const paragraphWithSep = paragraphSeparator + paragraph;

    // Try to fit the entire paragraph (with separator) into the current chunk
    if (current.length === 0 && paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    if (current.length > 0 && current.length + paragraphWithSep.length <= maxChars) {
      current += paragraphWithSep;
      continue;
    }

    // Paragraph doesn't fit in current chunk — flush current, then try paragraph alone
    flushCurrent();

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    // Paragraph itself is too long — split on lines
    const lines = paragraph.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineSeparator = li > 0 ? '\n' : '';

      const subLines = splitLongLine(line, maxChars);

      for (let si = 0; si < subLines.length; si++) {
        const subLine = subLines[si];
        // Use lineSeparator only for the first sub-piece of a non-first line
        const sep = si === 0 ? lineSeparator : '';

        const candidate = current.length === 0 ? subLine : current + sep + subLine;

        if (candidate.length <= maxChars) {
          current = candidate;
        } else {
          flushCurrent();
          current = subLine;
        }
      }
    }
  }

  flushCurrent();

  return chunks.length > 0 ? chunks : [''];
};

/**
 * Surrogate-safe UTF-16 slice: trims `text` to at most `budget` code units,
 * dropping a lone high surrogate at the cut boundary if present.
 */
const safeSlice = (text: string, budget: number): string => {
  let t = text.slice(0, budget);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t;
};

/**
 * Cap a chunked array to at most `maxPages` pages, appending a truncation
 * `suffix` to the last page (trimmed to fit within `maxChars` code units).
 * If the input already fits within the cap, it is returned unchanged.
 */
export const capPages = (
  chunks: ReadonlyArray<string>,
  maxPages: number,
  suffix: string,
  maxChars = 4096,
): ReadonlyArray<string> => {
  if (chunks.length <= maxPages) return chunks;

  const kept = chunks.slice(0, maxPages);
  const lastPage = kept[kept.length - 1] ?? '';

  let newLastPage: string;
  if (suffix.length >= maxChars) {
    // Pathological: suffix alone exceeds budget — use just the suffix trimmed
    newLastPage = safeSlice(suffix, maxChars);
  } else {
    const budget = maxChars - suffix.length;
    newLastPage = safeSlice(lastPage, budget) + suffix;
  }

  return [...kept.slice(0, kept.length - 1), newLastPage];
};
