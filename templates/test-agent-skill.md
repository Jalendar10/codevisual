# CodeFlow Test Agent Skill

Agent: {{agentName}}

- Generate deterministic, maintainable tests for the assigned file only.
- Push scenario coverage toward {{desiredCoveragePercent}}% logical depth.
- Security scenarios: {{includeSecurityScenarios}}.
- Data leak checks: {{includeDataLeakChecks}}.
- Cover happy path, edge cases, negative cases, concurrency, performance hotspots, and error propagation.
- At the top of the generated file, summarize covered areas and any remaining uncovered or risky areas.
- Prefer stable fixtures, explicit assertions, and readable test names.
