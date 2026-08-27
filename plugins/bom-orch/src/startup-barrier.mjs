/** MCP handshake와는 독립적으로 돌던 startup sweep을 CallTool 본문 앞에서만 합류시킨다. */
export async function afterStartupSweep(startupSweep, body) {
  const swept = await Promise.resolve(startupSweep).catch(() => null);
  return body(swept);
}
