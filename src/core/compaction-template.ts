export const COMPACTION_SUMMARY_TEMPLATE = `Summarize this conversation for context continuity. Use this structure:
## Goal
What the worker is trying to accomplish

## Progress
- Done: [completed items]
- In Progress: [current work]
- Blocked: [issues encountered]

## Key Decisions
Choices made and why

## Critical Context
File paths, variable names, API details that must be preserved

## Next Steps
What to do next`;

const MAX_MESSAGE_LENGTH = 500;

function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_LENGTH) {
    return content;
  }
  return content.slice(0, MAX_MESSAGE_LENGTH) + '...';
}

function formatMessage(msg: { role: string; content: string }): string {
  const text = typeof msg.content === 'string' ? msg.content : String(msg.content);
  return `${msg.role}: ${truncateMessage(text)}`;
}

export function buildCompactionPrompt(
  messages: Array<{ role: string; content: string }>,
): string {
  const transcript = messages.map(formatMessage).join('\n\n');

  return `${COMPACTION_SUMMARY_TEMPLATE}

---

Conversation transcript:

${transcript}`;
}
