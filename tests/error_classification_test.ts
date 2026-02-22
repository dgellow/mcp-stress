import { assertEquals } from "@std/assert";
import { classifyError, McpError } from "../src/transport/types.ts";

Deno.test("classifyError: McpError passes through", () => {
  const err = new McpError("server", -32603, "internal error", null, 100);
  const result = classifyError(err);
  assertEquals(result.category, "server");
  assertEquals(result.code, -32603);
  assertEquals(result.message, "internal error");
});

Deno.test("classifyError: DOMException TimeoutError", () => {
  const err = new DOMException("timed out", "TimeoutError");
  const result = classifyError(err);
  assertEquals(result.category, "timeout");
});

Deno.test("classifyError: DOMException AbortError", () => {
  const err = new DOMException("aborted", "AbortError");
  const result = classifyError(err);
  assertEquals(result.category, "timeout");
});

Deno.test("classifyError: SyntaxError is protocol", () => {
  const err = new SyntaxError("Unexpected token");
  const result = classifyError(err);
  assertEquals(result.category, "protocol");
  assertEquals(result.code, -32700);
});

Deno.test("classifyError: generic Error is client", () => {
  const err = new Error("something broke");
  const result = classifyError(err);
  assertEquals(result.category, "client");
});

Deno.test("classifyError: non-Error is client", () => {
  const result = classifyError("string error");
  assertEquals(result.category, "client");
  assertEquals(result.message, "string error");
});

Deno.test("classifyError: null is client", () => {
  const result = classifyError(null);
  assertEquals(result.category, "client");
});
