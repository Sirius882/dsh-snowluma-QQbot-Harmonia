export async function notifyAliveChat(config, event, request = fetch) {
  if (config.brain !== 'dsh') return;
  try {
    const response = await request(`${config.dshUrl}/harmonia/alive-chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(event), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Alive event rejected');
  } catch { console.error('[alive] chat event was not acknowledged; delivery will not be repeated'); }
}

export async function readAliveStatus(config, request = fetch) {
  try {
    const response = await request(`${config.dshUrl}/harmonia/alive-chat`, { method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!response.ok) return null;
    const status = await response.json();
    return status?.ok === true ? status : null;
  } catch { return null; }
}
