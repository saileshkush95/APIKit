// JSON Schema validation for response assertions.
//
// The other assertions check one value at a time, which is fine for a status
// code and useless for a contract: "the response is shaped like this" is the
// thing an API promises, and checking it field by field means writing a dozen
// assertions that still miss a renamed key.
//
// ajv rather than a hand-rolled subset. Real schemas are pasted out of OpenAPI
// documents and use `$ref`, `oneOf`, `format` and `additionalProperties`; a
// validator that quietly ignored the keywords it did not know would report a
// contract as kept when it was broken, which is worse than having no check.

import Ajv2020 from "ajv/dist/2020";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ErrorObject } from "ajv";

export interface SchemaCheck {
  valid: boolean;
  /** One line per problem, in the order ajv reported them. */
  errors: string[];
}

/**
 * Compiled validators, keyed by the schema text.
 *
 * Compiling is the expensive half, and a load test or a 500-iteration run
 * evaluates the same schema every time.
 */
const cache = new Map<string, { validate: ValidateLike } | { error: string }>();

type ValidateLike = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/**
 * Draft 2020-12 when the schema says so, draft-07 otherwise.
 *
 * OpenAPI 3.1 schemas are 2020-12 and 3.0 ones are draft-04-ish, which ajv reads
 * as draft-07. Guessing from `$schema` is what lets a schema pasted from either
 * one work without the user knowing which dialect they have.
 */
function compilerFor(schema: unknown) {
  const declared =
    typeof schema === "object" && schema !== null
      ? String((schema as Record<string, unknown>).$schema ?? "")
      : "";
  const is2020 = declared.includes("2020-12");

  // `strict: false` because a schema lifted out of an OpenAPI document carries
  // annotations ajv does not recognise — `example`, `nullable`, `discriminator`.
  // In strict mode those throw, which would reject the schema rather than the
  // response, and the user would have to edit their own contract to test it.
  const options = { strict: false, allErrors: true } as const;
  const ajv = is2020 ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv);
  return ajv;
}

/** `data/items/0/id must be string` — the path first, so it reads as a location. */
function describe(error: ErrorObject): string {
  const where = error.instancePath === "" ? "the response" : error.instancePath;
  const base = `${where} ${error.message ?? "is invalid"}`;
  // ajv puts the useful specifics in params rather than the message: which
  // property is missing, which values were allowed.
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "additionalProperties" && params.additionalProperty) {
    return `${base} (${String(params.additionalProperty)})`;
  }
  if (error.keyword === "enum" && Array.isArray(params.allowedValues)) {
    return `${base} (${params.allowedValues.map(String).join(", ")})`;
  }
  return base;
}

/**
 * Validates `body` against `schemaText`.
 *
 * A schema that will not compile and a body that will not parse are both
 * reported as failures rather than thrown, because an assertion has to produce
 * a result — a run cannot stop because one schema had a typo in it.
 */
export function checkSchema(schemaText: string, body: string): SchemaCheck {
  const text = schemaText.trim();
  if (text === "") {
    return { valid: false, errors: ["no schema given"] };
  }

  let entry = cache.get(text);
  if (entry === undefined) {
    try {
      const schema = JSON.parse(text);
      entry = { validate: compilerFor(schema).compile(schema) as ValidateLike };
    } catch (error) {
      entry = {
        error: `the schema itself is not usable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    cache.set(text, entry);
  }

  if ("error" in entry) {
    return { valid: false, errors: [entry.error] };
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { valid: false, errors: ["the response body is not JSON"] };
  }

  const valid = entry.validate(data);
  if (valid) return { valid: true, errors: [] };

  const errors = (entry.validate.errors ?? []).map(describe);
  return {
    valid: false,
    // A schema with a big `oneOf` can report dozens; the first few are what
    // actually identify the problem.
    errors: errors.length > 6 ? [...errors.slice(0, 6), `…and ${errors.length - 6} more`] : errors,
  };
}
