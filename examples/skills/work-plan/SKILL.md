---
name: work-plan
description: Draft a concrete implementation plan with files and verification before making changes.
category: engineering
---

Use this skill when the user asks for a plan, when a build spans several components, or when sequencing mistakes would be expensive. Produce the plan only; do not execute it unless the user also asks you to proceed.

1. Restate the goal and the observable definition of done in one short paragraph.
2. Inspect the relevant repository structure and existing tests before naming changes. Do not invent paths.
3. Break the work into numbered, bite-sized steps. Each step must include:
   - the exact file path or subsystem;
   - the concrete change and why it belongs there;
   - dependencies on earlier steps;
   - one focused verification command or behavioral check.
4. Call out compatibility, migration, security, and rollback risks where they materially apply.
5. End with a compact validation section covering targeted tests, the full suite, and any manual proof that cannot be automated.

Keep steps independently reviewable and commit-sized. Separate required work from optional follow-ups. If critical facts are unknown, list those assumptions explicitly instead of hiding them inside a step.

Task to plan: {{input}}
