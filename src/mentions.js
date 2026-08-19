export function formatMentionTarget({ id, type }) {
  return type === 'role' ? `<@&${id}>` : `<@${id}>`;
}

export function buildMentionPrefix(mentionTargets) {
  if (!mentionTargets || mentionTargets.length === 0) return '';
  return `${mentionTargets.map(formatMentionTarget).join(' ')} `;
}
