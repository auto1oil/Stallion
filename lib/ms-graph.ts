// ============================================================================
// Microsoft Graph client — server-only, app-only (client-credentials) auth.
// ============================================================================
// Reads a single mailbox (the GoDaddy/Microsoft 365 account that receives
// vendor bills) so the bills-ingest job can pull new invoice emails + their
// PDF/image attachments. App-only auth means no user is signed in — the Azure
// AD app holds application permission Mail.Read (and Mail.ReadWrite to mark
// messages read so they aren't ingested twice).
//
// Required env vars (set in Vercel):
//   - MS_TENANT_ID       Azure AD / Entra tenant id (GUID or domain)
//   - MS_CLIENT_ID       app registration (client) id
//   - MS_CLIENT_SECRET   app registration client secret
//   - BILLS_MAILBOX      mailbox to read, e.g. bills@yourdomain.com
//   - BILLS_MAIL_FOLDER  (optional) folder display name; defaults to Inbox

const GRAPH = 'https://graph.microsoft.com/v1.0';

export type GraphMessage = {
  id: string;
  subject: string | null;
  from: string | null;
  receivedDateTime: string | null;
};

export type GraphAttachment = {
  name: string;
  contentType: string;
  // base64-encoded file bytes (fileAttachment only)
  contentBytes: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — Microsoft Graph mailbox reading is not configured.`);
  return v;
}

async function getGraphToken(): Promise<string> {
  const tenant = requireEnv('MS_TENANT_ID');
  const body = new URLSearchParams({
    client_id: requireEnv('MS_CLIENT_ID'),
    client_secret: requireEnv('MS_CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`MS Graph token failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('MS Graph token response had no access_token');
  return json.access_token;
}

async function graphFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`MS Graph ${path} failed: ${res.status} ${await res.text()}`);
  // PATCH with no body returns 200/204 with no JSON.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Resolve the folder to read. Defaults to the well-known Inbox; if
// BILLS_MAIL_FOLDER names a custom folder, look up its id by display name.
async function resolveFolderPath(token: string, mailbox: string): Promise<string> {
  const folder = process.env.BILLS_MAIL_FOLDER?.trim();
  if (!folder || folder.toLowerCase() === 'inbox') {
    return `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox`;
  }
  const escaped = folder.replace(/'/g, "''");
  const res = await graphFetch<{ value: Array<{ id: string }> }>(
    token,
    `/users/${encodeURIComponent(mailbox)}/mailFolders?$filter=${encodeURIComponent(`displayName eq '${escaped}'`)}&$select=id`,
  );
  const id = res.value?.[0]?.id;
  if (!id) throw new Error(`Mail folder "${folder}" not found in ${mailbox}.`);
  return `/users/${encodeURIComponent(mailbox)}/mailFolders/${id}`;
}

// Recent messages with attachments in the bills folder — read OR unread. We
// don't filter on isRead because this is a personal inbox where the user reads
// their mail; instead, ingestion dedupes by message id (source_message_id), so
// reading a vendor's invoice no longer hides it from the poller.
export async function listBillMessages(limit = 40): Promise<GraphMessage[]> {
  const token = await getGraphToken();
  const mailbox = requireEnv('BILLS_MAILBOX');
  const folderPath = await resolveFolderPath(token, mailbox);
  // Single filter, no $orderby (avoids Graph's "InefficientFilter" 400); we
  // sort newest-first in code so recent bills are handled within the limit.
  const q =
    `?$filter=${encodeURIComponent('hasAttachments eq true')}` +
    `&$select=id,subject,from,receivedDateTime&$top=100`;
  const res = await graphFetch<{
    value: Array<{ id: string; subject?: string; receivedDateTime?: string; from?: { emailAddress?: { address?: string } } }>;
  }>(token, `${folderPath}/messages${q}`);
  return (res.value || [])
    .map((m) => ({
      id: m.id,
      subject: m.subject ?? null,
      from: m.from?.emailAddress?.address ?? null,
      receivedDateTime: m.receivedDateTime ?? null,
    }))
    .sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || '')) // newest first
    .slice(0, limit);
}

// PDF/image file attachments on a message (base64 bytes included).
export async function getMessageAttachments(messageId: string): Promise<GraphAttachment[]> {
  const token = await getGraphToken();
  const mailbox = requireEnv('BILLS_MAILBOX');
  const res = await graphFetch<{
    value: Array<{ '@odata.type'?: string; name?: string; contentType?: string; contentBytes?: string }>;
  }>(token, `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`);
  return (res.value || [])
    .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
    .filter((a) => {
      const ct = (a.contentType || '').toLowerCase();
      const name = (a.name || '').toLowerCase();
      return ct === 'application/pdf' || ct.startsWith('image/') || name.endsWith('.pdf');
    })
    .map((a) => ({ name: a.name || 'attachment', contentType: a.contentType || 'application/octet-stream', contentBytes: a.contentBytes! }));
}

// Mark a message read so the next poll skips it.
export async function markMessageRead(messageId: string): Promise<void> {
  const token = await getGraphToken();
  const mailbox = requireEnv('BILLS_MAILBOX');
  await graphFetch(token, `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true }),
  });
}

export type GraphMessageBody = GraphMessage & { text: string };

// Rough HTML→text so the rack-price parser (which keys off line shapes) still
// works when the supplier sends an HTML email. Block tags become newlines, the
// rest is stripped, and a few common entities are decoded.
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/div|\/p|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

// Recent messages with their body text, read OR unread, optionally filtered to
// a single sender (the DTN/Sinclair rack-price address). Used by rack-price
// ingestion — these emails carry the prices in the body, not an attachment. We
// don't filter on isRead (personal inbox); re-parsing is idempotent (rack
// prices upsert), so reading the email never hides it.
export async function listMessagesWithBody(
  fromAddress?: string,
  limit = 25,
): Promise<GraphMessageBody[]> {
  const token = await getGraphToken();
  const mailbox = requireEnv('BILLS_MAILBOX');
  const folderPath = await resolveFolderPath(token, mailbox);
  // Filter only by sender (if provided). No isRead, no $orderby (avoids Graph's
  // "InefficientFilter" 400); sort newest-first in code below.
  const filter = fromAddress
    ? `from/emailAddress/address eq '${fromAddress.replace(/'/g, "''")}'`
    : '';
  const q =
    `?${filter ? `$filter=${encodeURIComponent(filter)}&` : ''}` +
    `$select=id,subject,from,receivedDateTime,body&$top=${Math.max(limit, 50)}`;
  const res = await graphFetch<{
    value: Array<{
      id: string; subject?: string; receivedDateTime?: string;
      from?: { emailAddress?: { address?: string } };
      body?: { contentType?: string; content?: string };
    }>;
  }>(token, `${folderPath}/messages${q}`);
  return (res.value || []).map((m) => {
    const content = m.body?.content || '';
    const text = (m.body?.contentType || '').toLowerCase() === 'html' ? htmlToText(content) : content;
    return {
      id: m.id,
      subject: m.subject ?? null,
      from: m.from?.emailAddress?.address ?? null,
      receivedDateTime: m.receivedDateTime ?? null,
      text,
    };
  })
    .sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || '')) // newest first
    .slice(0, limit);
}
