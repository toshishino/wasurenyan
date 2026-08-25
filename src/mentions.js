export function formatMentionTarget({ id, type }) {
  return type === 'role' ? `<@&${id}>` : `<@${id}>`;
}

// id+typeの組み合わせで重複を除いたメンション対象配列を返す
export function dedupeMentionTargets(mentionTargets) {
  const seen = new Set();
  const result = [];
  for (const target of mentionTargets ?? []) {
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

export function buildMentionPrefix(mentionTargets) {
  if (!mentionTargets || mentionTargets.length === 0) return '';
  return `${mentionTargets.map(formatMentionTarget).join(' ')} `;
}
