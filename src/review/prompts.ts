/** Build a review prompt for a specific reviewer type */
export function buildReviewPrompt(
  reviewType: string,
  repoFullName: string,
  branch: string,
): string {
  const prompts: Record<string, string> = {
    security: securityPrompt(branch),
    quality: qualityPrompt(branch),
    waste: wastePrompt(branch),
    tests: testsPrompt(branch),
    performance: performancePrompt(branch),
  };
  return prompts[reviewType] || qualityPrompt(branch);
}

function securityPrompt(branch: string): string {
  return `# Security Review Agent

Review the code changes on branch \`${branch}\` for security issues.

## Scope
Run: \`git diff main...${branch} --name-only\` to see changed files. Review ONLY those files.

## What to Check
- SQL injection, XSS, CSRF vulnerabilities
- Authentication/authorization bypass
- Secrets, API keys, tokens hardcoded in source
- Input validation and sanitization gaps
- Error messages leaking internal details
- Insecure dependencies (check package.json changes)
- Missing rate limiting on public endpoints
- Path traversal in file operations
- Unsafe deserialization

## Output Format
Output ONLY a JSON array. No other text before or after. Each finding:
\`\`\`json
[{
  "file": "src/auth.ts",
  "line_start": 42,
  "line_end": 45,
  "severity": "critical",
  "category": "security",
  "confidence": 92,
  "title": "Short title of the issue",
  "description": "Specific explanation of THIS instance — not generic advice",
  "suggestion": "Concrete fix with code if possible"
}]
\`\`\`

If no issues found, output: \`[]\`
Do NOT pad with generic advice. Only report REAL issues you can point to with file and line.`;
}

function qualityPrompt(branch: string): string {
  return `# Code Quality Review Agent

Review the code changes on branch \`${branch}\` for quality issues.

## Scope
Run: \`git diff main...${branch} --name-only\` to see changed files.
Read CLAUDE.md first for project conventions. Review ONLY changed files.

## What to Check
- Functions over 50 lines or deeply nested (>3 levels)
- Code duplication across files
- Poor naming (vague variables, misleading function names)
- Missing or misleading comments on complex logic
- Architectural pattern violations (check CLAUDE.md)
- Dead code or unused imports
- Missing error handling on I/O operations
- Inconsistent patterns within the codebase

## Output Format
Output ONLY a JSON array. No other text. Each finding:
\`\`\`json
[{
  "file": "src/service.ts",
  "line_start": 10,
  "line_end": 80,
  "severity": "high",
  "category": "quality",
  "confidence": 85,
  "title": "Function exceeds complexity threshold",
  "description": "processOrder() is 70 lines with 4 levels of nesting — hard to test and maintain",
  "suggestion": "Extract validation into validateOrder() and payment into processPayment()"
}]
\`\`\`

If no issues found, output: \`[]\`
Maximum 10 findings. Rank by impact × effort.`;
}

function wastePrompt(branch: string): string {
  return `# Waste & Simplification Review Agent

Review branch \`${branch}\` and ask: "Could this be simpler?"

## Scope
Run: \`git diff main...${branch} --name-only\` to see changed files.

## What to Check
- Over-engineered abstractions used exactly once
- Premature optimization without benchmarks
- Config objects where a simple parameter would work
- Factory patterns for single implementations
- Unnecessary intermediate variables or wrapper functions
- Complex type gymnastics that hurt readability
- Dependencies added for trivial functionality (could be 5 lines of code)
- Files that could be deleted entirely
- Abstractions that don't abstract anything

## Output Format
Output ONLY a JSON array. Each finding:
\`\`\`json
[{
  "file": "src/utils/factory.ts",
  "line_start": 1,
  "line_end": 45,
  "severity": "medium",
  "category": "waste",
  "confidence": 88,
  "title": "AuthConfigFactory used exactly once",
  "description": "Factory creates one config object in one place — adds indirection without value",
  "suggestion": "Replace with a plain object literal in auth.ts"
}]
\`\`\`

If no issues: \`[]\`
Maximum 10 findings.`;
}

function testsPrompt(branch: string): string {
  return `# Test Coverage Review Agent

Review branch \`${branch}\` for test quality and coverage.

## Scope
Run: \`git diff main...${branch} --name-only\` to see changed files.
Run tests if available: \`npm test 2>&1 | tail -50\`

## What to Check
- Critical paths without tests (auth, payments, data mutations)
- Tests that check implementation details instead of behavior
- Missing edge case coverage (null, empty, boundary values, error paths)
- Flakiness risks (timing dependencies, network calls, shared state)
- Missing error path tests (what happens when X fails?)
- Test descriptions that don't match what they actually test
- Snapshot tests for complex logic (lazy testing)
- Missing integration tests for multi-component flows

## Output Format
Output ONLY a JSON array. Each finding:
\`\`\`json
[{
  "file": "src/auth.ts",
  "line_start": 42,
  "line_end": 55,
  "severity": "high",
  "category": "tests",
  "confidence": 90,
  "title": "No test for token refresh flow",
  "description": "refreshToken() handles expiry but no test covers the expired-token-then-retry path",
  "suggestion": "Add test: 'should refresh expired token and retry the original request'"
}]
\`\`\`

If coverage looks good: \`[]\``;
}

function performancePrompt(branch: string): string {
  return `# Performance Review Agent

Review branch \`${branch}\` for performance issues.

## Scope
Run: \`git diff main...${branch} --name-only\` to see changed files.

## What to Check
- N+1 database queries (loops with queries inside)
- Blocking operations in async contexts (sync I/O in request handlers)
- Missing pagination on list endpoints
- Memory leaks (event listeners not removed, growing arrays/maps)
- Expensive operations in hot paths (regex compilation, JSON.parse in loops)
- Missing caching for repeated expensive operations
- Large payloads without streaming
- Missing database indexes (if schema files are present)
- Unbounded data fetches (SELECT * without LIMIT)

## Output Format
Output ONLY a JSON array. Each finding:
\`\`\`json
[{
  "file": "src/api/users.ts",
  "line_start": 23,
  "line_end": 30,
  "severity": "high",
  "category": "performance",
  "confidence": 95,
  "title": "N+1 query in user listing",
  "description": "Loop at line 25 fetches orders per user instead of batching — causes O(n) DB calls",
  "suggestion": "Batch fetch with WHERE user_id IN (...) before the loop"
}]
\`\`\`

If no issues: \`[]\``;
}
