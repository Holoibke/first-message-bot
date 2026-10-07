'use strict';

/**
 * A very small "JSON with comments" parser, so config.json can be documented
 * inline without pulling in a dependency (no JSON5, no strip-json-comments).
 *
 * Supported on top of plain JSON:
 *   - slash-slash line comments
 *   - slash-star block comments
 *   - trailing commas before closing braces/brackets
 *
 * Implementation detail: comments and trailing commas are replaced by spaces
 * rather than deleted, so byte offsets (and therefore JSON.parse's
 * "(line X column Y)" error messages) stay accurate.
 */

function maskComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i++;
      } else {
        out += ch === '\n' ? ch : ' ';
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i++;
      continue;
    }
    out += ch;
  }

  return out;
}

function maskTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // Look ahead: is the next non-whitespace character a closing bracket?
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        out += ' ';
        continue;
      }
    }
    out += ch;
  }

  return out;
}

/**
 * @param {string} text raw file contents
 * @param {string} [sourceName] used in error messages
 * @returns {any} parsed value
 */
function parseJsonc(text, sourceName = 'config') {
  const cleaned = maskTrailingCommas(maskComments(text));
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const message = String(err.message).replace(/ in JSON at position \d+/, '');
    throw new Error(`Could not parse ${sourceName}: ${message}`);
  }
}

module.exports = { parseJsonc, maskComments, maskTrailingCommas };
