/**
 * A small JSON Schema validator covering exactly the keywords used by
 * schema/approved-testimonials.schema.json.
 *
 * Why not ajv: this repository is a plain GitHub Pages site with no build step
 * and no node_modules. Vendoring a validator for eleven keywords is cheaper than
 * introducing a dependency tree into a static site, and it keeps the publisher
 * runnable with nothing but a stock Node install.
 *
 * Supported: type (incl. unions), required, properties, additionalProperties,
 * items, enum, const, pattern, minLength, minimum, and the date / date-time /
 * uri formats. Unsupported keywords are ignored rather than silently passing a
 * document they were meant to constrain, so keep the schema within this subset.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'minLength', 'minimum',
  'format',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function checkFormat(value, format) {
  if (typeof value !== 'string') return null;
  switch (format) {
    case 'date':
      return DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'is not a valid date';
    case 'date-time':
      return Number.isNaN(Date.parse(value)) ? 'is not a valid date-time' : null;
    case 'uri':
      try {
        const url = new URL(value);
        return url.protocol ? null : 'is not a valid URI';
      } catch {
        return 'is not a valid URI';
      }
    default:
      return null;
  }
}

function walk(value, schema, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      errors.push(`${path}: schema uses unsupported keyword "${keyword}"`);
    }
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${expected.join(' or ')}, got ${typeOf(value)}`);
      return; // Further checks would be noise once the type is wrong.
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
    if (schema.format !== undefined) {
      const problem = checkFormat(value, schema.format);
      if (problem) errors.push(`${path}: ${problem}`);
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`);
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) walk(value[key], subSchema, `${path}/${key}`, errors);
    }
  }

  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, index) => walk(item, schema.items, `${path}/${index}`, errors));
  }
}

/**
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(document, schema) {
  const errors = [];
  walk(document, schema, '#', errors);
  return { valid: errors.length === 0, errors };
}

/** Throws with every failure listed, rather than only the first. */
export function assertValid(document, schema, label = 'document') {
  const { valid, errors } = validate(document, schema);
  if (!valid) {
    throw new Error(`${label} failed schema validation:\n  - ${errors.join('\n  - ')}`);
  }
}
