import { describe, it, expect } from "vitest";
import { buildSpecReviewPrompt } from "../../src/review/prompts.js";
import type { Task } from "../../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add auth middleware",
    description: "Implement JWT authentication middleware",
    acceptance_criteria: ["Validates JWT tokens", "Returns 401 on invalid token", "Passes valid tokens to next()"],
    depends_on: [],
    conflicts_with: [],
    priority: "p0",
    complexity: "integration",
    steps: [],
    retry_count: 0,
    status: "done",
    ...overrides,
  };
}

describe("buildSpecReviewPrompt", () => {
  it("includes all acceptance criteria", () => {
    const prompt = buildSpecReviewPrompt(makeTask(), "diff content");
    expect(prompt).toContain("1. Validates JWT tokens");
    expect(prompt).toContain("2. Returns 401 on invalid token");
    expect(prompt).toContain("3. Passes valid tokens to next()");
  });

  it("includes the diff", () => {
    const prompt = buildSpecReviewPrompt(makeTask(), "+const auth = jwt.verify(token)");
    expect(prompt).toContain("+const auth = jwt.verify(token)");
  });

  it("includes verify_command when present", () => {
    const prompt = buildSpecReviewPrompt(
      makeTask({ verify_command: "npm test -- --grep auth" }),
      "diff",
    );
    expect(prompt).toContain("npm test -- --grep auth");
    expect(prompt).toContain("Verification Command");
  });

  it("omits verify section when no verify_command", () => {
    const prompt = buildSpecReviewPrompt(makeTask(), "diff");
    expect(prompt).not.toContain("Verification Command");
  });

  it("includes task title and description", () => {
    const prompt = buildSpecReviewPrompt(makeTask(), "diff");
    expect(prompt).toContain("Add auth middleware");
    expect(prompt).toContain("JWT authentication middleware");
  });

  it("requests JSON output format", () => {
    const prompt = buildSpecReviewPrompt(makeTask(), "diff");
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"reasons"');
  });
});
