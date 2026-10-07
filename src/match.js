'use strict';

/**
 * Matching helpers. A "reference" is a single entry from the config
 * (a name, "#name" or an ID); a "target" is a Discord object
 * ({ id, name }) taken from the live gateway objects.
 */

const ID_LIKE = /^\d{15,25}$/;

function clean(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
}

/** Does one config entry point at this target? */
function matchesReference(reference, target) {
  if (!target) return false;
  const ref = clean(reference);
  if (!ref) return false;

  if (ID_LIKE.test(String(reference).trim().replace(/^#/, ''))) {
    return String(target.id) === String(reference).trim().replace(/^#/, '');
  }
  return clean(target.name) === ref;
}

/**
 * Does any config entry point at one of the targets?
 * @param {string[]} references config list
 * @param {Array<{id?: string, name?: string}>} targets e.g. [channel, parent, category]
 */
function matchesAnyReference(references, targets) {
  if (!Array.isArray(references) || !references.length) return false;
  const list = Array.isArray(targets) ? targets : [targets];
  return references.some((ref) => list.some((target) => matchesReference(ref, target)));
}

module.exports = { matchesReference, matchesAnyReference, clean };
