# Agent Working Agreement

## Core principles

- Do the right work: understand the request, inspect relevant context, and solve the underlying problem without expanding scope unnecessarily.
- Prefer simple, maintainable solutions over clever ones.
- Preserve existing user work. Do not overwrite, revert, or clean up unrelated changes.
- Make assumptions explicit when they materially affect the result.

## Before changing code

- Read the relevant files and follow existing project conventions.
- Check the working tree before editing; treat existing changes as owned by someone else unless told otherwise.
- Keep changes focused. Avoid drive-by refactors, formatting churn, and unrelated dependency updates.

## Implementation standards

- Write clear, idiomatic code with useful names and small, cohesive units.
- Handle expected errors and edge cases; do not silently swallow failures.
- Avoid secrets, credentials, personal data, and generated build artifacts in source control.
- Update tests, documentation, and configuration when the change requires them.

## Validation

- Run the most relevant available checks before handing work off.
- Report what was validated and clearly call out anything not run or any known limitation.
- Do not claim a change works without evidence.

## Git and commits

- Keep commits small, focused, and independently useful.
- Write short imperative commit messages, for example: `Add health check endpoint`.
- Do not commit unrelated files, generated output, secrets, or another contributor's work.
- Never use destructive Git commands or rewrite shared history without explicit approval.
- Do not commit until the task is complete and the user has approved the changes.
- Commit once the user approves, using a single focused commit for the approved work.

## Collaboration

- Communicate progress concisely, including blockers and decisions that need input.
- Ask before actions that are destructive, irreversible, externally visible, or meaningfully broaden scope.
- Leave the repository in a clean, understandable state for the next person.
- Once a task is done, stop and wait for the user to review and approve before committing or moving on to the next task.
- Present completed work for review with a short summary of what changed and how it was validated.
