import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID     = Deno.env.get('GCAL_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GCAL_CLIENT_SECRET')!;
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT_URI  = `${SUPABASE_URL}/functions/v1/gcal-proxy`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action');
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');   // 'personal' | 'work'
  const source = url.searchParams.get('source');

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── OAuth callback from Google ─────────────────────────────────────────────
  if (code && !action) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (tokens.error) {
        return new Response(`Auth error: ${tokens.error_description || tokens.error}`, { status: 400 });
      }

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userRes.json();

      await db.from('calendar_tokens').upsert({
        id: state || 'personal',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
        email: userInfo.email,
        updated_at: new Date().toISOString(),
      });

      const src = state || 'personal';
      const html = `<!DOCTYPE html><html><head><title>Connected</title></head><body>
<p style="font-family:sans-serif;text-align:center;margin-top:60px;color:#2C2A26;">
  ✓ Calendar connected. Closing…
</p>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({ type: 'gcal-connected', source: '${src}' }, '*');
      setTimeout(() => window.close(), 800);
    } else {
      document.querySelector('p').textContent = 'Connected! You can close this window.';
    }
  } catch(e) {}
</script></body></html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch (err) {
      return new Response('Server error: ' + (err as Error).message, { status: 500 });
    }
  }

  // ── auth-url ───────────────────────────────────────────────────────────────
  if (action === 'auth-url') {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', source || 'personal');
    return json({ url: authUrl.toString() });
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const { data } = await db.from('calendar_tokens').select('id, email, updated_at');
    return json({ tokens: data || [] });
  }

  // ── events ─────────────────────────────────────────────────────────────────
  if (action === 'events') {
    const { data: tokenRow } = await db
      .from('calendar_tokens')
      .select('*')
      .eq('id', source || 'personal')
      .single();

    if (!tokenRow) return json({ error: 'not_connected' }, 401);

    let accessToken = tokenRow.access_token;
    if (new Date(tokenRow.token_expiry) <= new Date()) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: tokenRow.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const refreshed = await refreshRes.json();
      if (!refreshed.error) {
        accessToken = refreshed.access_token;
        await db.from('calendar_tokens').update({
          access_token: accessToken,
          token_expiry: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
        }).eq('id', source);
      }
    }

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const eventsRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&` +
      `singleEvents=true&orderBy=startTime&maxResults=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const eventsData = await eventsRes.json();
    if (eventsData.error) return json({ error: eventsData.error.message }, 400);
    return json({ events: eventsData.items || [] });
  }

  // ── disconnect ─────────────────────────────────────────────────────────────
  if (action === 'disconnect') {
    await db.from('calendar_tokens').delete().eq('id', source || 'personal');
    return json({ ok: true });
  }

  return new Response('Not found', { status: 404, headers: CORS });
});
