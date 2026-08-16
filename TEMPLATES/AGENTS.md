# Contributor and Agent Guidance

> [!NOTE]
> This file provides experimental, non-enforcing guidance. Follow the repository's explicit instructions and verified project commands.

## 🧭 Working Approach

1. Start from a GitHub Issue with a clear outcome.
2. Implement the smallest coherent change that satisfies the Issue.
3. Keep code, tests, and documentation consistent.
4. Run the relevant repository checks and record the results.
5. Open a pull request linked to the Issue.
6. Allow `PR Gate` to run.
7. When repository settings permit it, use native squash auto-merge after the gate passes.

Prefer direct, maintainable solutions. Avoid unrelated cleanup and speculative abstractions.

## ✅ Evidence

Inspect the final diff, check for whitespace errors, run affected formatters and tests, and report the exact commands and results. State clearly when a relevant check could not be run.

## 🔒 AI Agent Boundaries

**May**, only when explicitly tasked: create Issues, branches, commits, pull requests, descriptions, code, tests, and documentation.

**Must not**: submit reviews, request reviewers, approve changes, block a pipeline, or post an unsolicited comment. An agent may answer a direct question when explicitly tagged in an Issue or pull request.

## 🔗 External Guidance

A reference to shared guidance is informational. Adoption is deliberate and does not automatically change this repository. Repository-specific instructions take precedence.
