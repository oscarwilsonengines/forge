import { describe, it, expect } from "vitest";
import {
  TaskStepSchema, TaskSchema, TaskComplexity, PlanSchema, PlanStatus,
  ForgeConfigSchema,
} from "../../src/types.js";

describe("TaskStepSchema", () => {
  it("accepts valid step with all fields", () => {
    const step = TaskStepSchema.parse({
      action: "Write failing test",
      code: "expect(1).toBe(2)",
      verify: "npm test",
      expected: "FAIL",
    });
    expect(step.action).toBe("Write failing test");
    expect(step.code).toBe("expect(1).toBe(2)");
  });

  it("accepts step with only action", () => {
    const step = TaskStepSchema.parse({ action: "Commit changes" });
    expect(step.action).toBe("Commit changes");
    expect(step.code).toBeUndefined();
    expect(step.verify).toBeUndefined();
  });

  it("rejects step without action", () => {
    expect(() => TaskStepSchema.parse({ code: "foo" })).toThrow();
  });
});

describe("TaskSchema - new fields", () => {
  const baseTask = {
    id: "task-1",
    title: "Test task",
    description: "A test",
    acceptance_criteria: ["It works"],
    depends_on: [],
    priority: "p0" as const,
    status: "todo" as const,
  };

  it("defaults complexity to integration", () => {
    const task = TaskSchema.parse(baseTask);
    expect(task.complexity).toBe("integration");
  });

  it("accepts all complexity values", () => {
    for (const c of ["mechanical", "integration", "architecture"] as const) {
      const task = TaskSchema.parse({ ...baseTask, complexity: c });
      expect(task.complexity).toBe(c);
    }
  });

  it("rejects invalid complexity", () => {
    expect(() => TaskSchema.parse({ ...baseTask, complexity: "easy" })).toThrow();
  });

  it("defaults steps to empty array", () => {
    const task = TaskSchema.parse(baseTask);
    expect(task.steps).toEqual([]);
  });

  it("accepts steps array", () => {
    const task = TaskSchema.parse({
      ...baseTask,
      steps: [{ action: "Write test" }, { action: "Implement", code: "x = 1" }],
    });
    expect(task.steps).toHaveLength(2);
  });

  it("defaults retry_count to 0", () => {
    const task = TaskSchema.parse(baseTask);
    expect(task.retry_count).toBe(0);
  });

  it("accepts verify_command", () => {
    const task = TaskSchema.parse({ ...baseTask, verify_command: "npm test" });
    expect(task.verify_command).toBe("npm test");
  });

  it("backward compat: old task data without new fields still parses", () => {
    const task = TaskSchema.parse(baseTask);
    expect(task.complexity).toBe("integration");
    expect(task.steps).toEqual([]);
    expect(task.retry_count).toBe(0);
    expect(task.verify_command).toBeUndefined();
  });
});

describe("PlanSchema - new fields", () => {
  it("includes designing in PlanStatus", () => {
    expect(PlanStatus.options).toContain("designing");
  });

  it("accepts design_doc field", () => {
    const plan = PlanSchema.parse({
      project: "test",
      projectRoot: "/tmp",
      repo: "org/test",
      description: "Test plan",
      design_doc: ".forge/design.md",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "designing",
      tasks: [],
    });
    expect(plan.design_doc).toBe(".forge/design.md");
    expect(plan.status).toBe("designing");
  });

  it("backward compat: plan without design_doc parses", () => {
    const plan = PlanSchema.parse({
      project: "test",
      projectRoot: "/tmp",
      repo: "org/test",
      description: "Test",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "draft",
      tasks: [],
    });
    expect(plan.design_doc).toBeUndefined();
  });
});

describe("ForgeConfigSchema - model_routing", () => {
  it("defaults model_routing to haiku/sonnet/opus", () => {
    const config = ForgeConfigSchema.parse({
      github: { org: "test" },
      hosts: { local: { type: "local" } },
      agents: {},
      review: {},
      notifications: {},
    });
    expect(config.agents.model_routing).toEqual({
      mechanical: "haiku",
      integration: "sonnet",
      architecture: "opus",
    });
  });

  it("accepts custom model_routing", () => {
    const config = ForgeConfigSchema.parse({
      github: { org: "test" },
      hosts: { local: { type: "local" } },
      agents: { model_routing: { mechanical: "flash", integration: "sonnet", architecture: "opus" } },
      review: {},
      notifications: {},
    });
    expect(config.agents.model_routing.mechanical).toBe("flash");
  });

  it("backward compat: config without model_routing parses", () => {
    const config = ForgeConfigSchema.parse({
      github: { org: "test" },
      hosts: { local: { type: "local" } },
      agents: {},
      review: {},
      notifications: {},
    });
    expect(config.agents.model_routing).toBeDefined();
  });
});
