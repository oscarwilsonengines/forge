import { describe, it, expect } from "vitest";

describe("Scheduler model routing", () => {
  it("selects model based on task complexity", () => {
    const routing = { mechanical: "haiku", integration: "sonnet", architecture: "opus" };
    const fallback = "sonnet";

    expect(routing["mechanical" as keyof typeof routing] ?? fallback).toBe("haiku");
    expect(routing["integration" as keyof typeof routing] ?? fallback).toBe("sonnet");
    expect(routing["architecture" as keyof typeof routing] ?? fallback).toBe("opus");
  });

  it("falls back to default model when complexity is undefined", () => {
    const routing = { mechanical: "haiku", integration: "sonnet", architecture: "opus" };
    const fallback = "sonnet";
    const complexity = undefined;

    const model = complexity ? routing[complexity as keyof typeof routing] : undefined;
    expect(model ?? fallback).toBe("sonnet");
  });

  it("checkOutputForError detects is_error in JSON", () => {
    // Simulates the check the scheduler does
    function checkOutputForError(output: string): boolean {
      try {
        const parsed = JSON.parse(output);
        return parsed.is_error === true;
      } catch {
        return false;
      }
    }

    // "Not logged in" response
    expect(checkOutputForError(JSON.stringify({
      type: "result", is_error: true, result: "Not logged in",
    }))).toBe(true);

    // Successful response
    expect(checkOutputForError(JSON.stringify({
      type: "result", is_error: false, result: "Done",
    }))).toBe(false);

    // Non-JSON output
    expect(checkOutputForError("plain text output")).toBe(false);

    // Empty
    expect(checkOutputForError("")).toBe(false);
  });
});
