import { assertEquals } from "@std/assert";
import {
  generateArgsFromSchema,
  generateRandomArgsFromSchema,
  rng,
  setSeed,
} from "../src/schema.ts";

Deno.test("rng: seeded determinism", () => {
  setSeed(12345);
  const a = rng();
  const b = rng();

  setSeed(12345);
  assertEquals(rng(), a);
  assertEquals(rng(), b);
});

Deno.test("rng: different seeds produce different sequences", () => {
  setSeed(1);
  const a = rng();

  setSeed(2);
  const b = rng();

  assertEquals(a !== b, true);
});

Deno.test("generateArgsFromSchema: required string field", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const args = generateArgsFromSchema(schema);
  assertEquals(typeof args.name, "string");
});

Deno.test("generateArgsFromSchema: enum picks first value", () => {
  const schema = {
    type: "object",
    properties: { lang: { type: "string", enum: ["go", "python", "rust"] } },
    required: ["lang"],
  };
  const args = generateArgsFromSchema(schema);
  assertEquals(args.lang, "go");
});

Deno.test("generateArgsFromSchema: skips non-required fields", () => {
  const schema = {
    type: "object",
    properties: {
      required_field: { type: "string" },
      optional_field: { type: "string" },
    },
    required: ["required_field"],
  };
  const args = generateArgsFromSchema(schema);
  assertEquals("required_field" in args, true);
  assertEquals("optional_field" in args, false);
});

Deno.test("generateRandomArgsFromSchema: varies with seed", () => {
  const schema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  };

  setSeed(100);
  const a = generateRandomArgsFromSchema(schema);

  setSeed(200);
  const b = generateRandomArgsFromSchema(schema);

  assertEquals(a.q !== b.q, true);
});

Deno.test("generateRandomArgsFromSchema: enum randomization", () => {
  const schema = {
    type: "object",
    properties: {
      lang: { type: "string", enum: ["a", "b", "c", "d", "e", "f"] },
    },
    required: ["lang"],
  };

  setSeed(42);
  const values = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const args = generateRandomArgsFromSchema(schema);
    values.add(args.lang as string);
  }

  // With 20 draws from 6 options, we should see at least 2 different values
  assertEquals(values.size > 1, true);
});

Deno.test("generateArgsFromSchema: empty schema returns empty", () => {
  assertEquals(Object.keys(generateArgsFromSchema(undefined)).length, 0);
  assertEquals(Object.keys(generateArgsFromSchema({})).length, 0);
});
