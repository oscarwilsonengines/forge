import { describe, it, expect } from "vitest";
import { buildWorkerPrompt } from "../../src/workers/prompts.js";
import type { SpawnOptions } from "../../src/execution/engine.js";

function makeOpts(overrides: Partial<SpawnOptions["task"]> = {}): SpawnOptions {
  return {
    task: {
      id: "task-1",
      title: "Test task",
      description: "Implement the thing",
      acceptance_criteria: ["It works", "Tests pass"],
      depends_on: [],
      conflicts_with: [],
      priority: "p0",
      complexity: "integration",
      steps: [],
      retry_count: 0,
      status: "todo",
      issue_number: 42,
      ...overrides,
    },
    repoFullName: "org/repo",
    projectRoot: "/tmp/project",
    model: "sonnet",
    maxTurns: 25,
    allowedTools: [],
  };
}

describe("buildWorkerPrompt", () => {
  it("includes task title and description", () => {
    const prompt = buildWorkerPrompt(makeOpts());
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("Implement the thing");
  });

  it("includes acceptance criteria", () => {
    const prompt = buildWorkerPrompt(makeOpts());
    expect(prompt).toContain("1. It works");
    expect(prompt).toContain("2. Tests pass");
  });

  it("includes status protocol section", () => {
    const prompt = buildWorkerPrompt(makeOpts());
    expect(prompt).toContain("STATUS: DONE");
    expect(prompt).toContain("STATUS: DONE_WITH_CONCERNS");
    expect(prompt).toContain("STATUS: NEEDS_CONTEXT");
    expect(prompt).toContain("STATUS: BLOCKED");
  });

  it("includes steps when present", () => {
    const prompt = buildWorkerPrompt(makeOpts({
      steps: [
        { action: "Write failing test", code: "expect(1).toBe(2)", verify: "npm test", expected: "FAIL" },
        { action: "Implement", code: "return 1" },
      ],
    }));
    expect(prompt).toContain("Step 1: Write failing test");
    expect(prompt).toContain("expect(1).toBe(2)");
    expect(prompt).toContain("Verify: `npm test`");
    expect(prompt).toContain("Expected: FAIL");
    expect(prompt).toContain("Step 2: Implement");
  });

  it("omits steps section when steps is empty", () => {
    const prompt = buildWorkerPrompt(makeOpts({ steps: [] }));
    expect(prompt).not.toContain("Implementation Steps");
  });

  it("includes verification section when verify_command is set", () => {
    const prompt = buildWorkerPrompt(makeOpts({ verify_command: "npm test && npm run lint" }));
    expect(prompt).toContain("Verification (REQUIRED)");
    expect(prompt).toContain("npm test && npm run lint");
  });

  it("omits verification section when no verify_command", () => {
    const prompt = buildWorkerPrompt(makeOpts());
    expect(prompt).not.toContain("Verification (REQUIRED)");
  });

  it("backward compat: task without new fields still produces valid prompt", () => {
    const prompt = buildWorkerPrompt(makeOpts());
    expect(prompt).toContain("Forge Worker Agent");
    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).toContain("Constraints");
  });
});
