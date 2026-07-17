<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiPost, apiPut, apiDelete, messageFrom } from '$lib/api.js';

  /* The SMTP transport, editable in place. Stored settings take precedence
     over the environment; clearing them falls back to whatever the .env
     carries. The password is write-only: the server reports has_pass and
     an omitted password keeps the stored one. */

  type Stored = {
    smtp_url: string | null;
    host: string | null;
    port: number | null;
    user: string | null;
    has_pass: boolean;
    secure: boolean | null;
    mail_from: string | null;
  };
  type View = {
    stored: Stored | null;
    active: { state: 'ready' | 'disabled' | 'error'; detail: string | null; source: 'settings' | 'env' | 'none' };
    policy: { invites: boolean; digests: boolean };
  };

  let view = $state<View | null>(null);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);

  /* One form, two shapes: a single URL, or the discrete fields. The mode
     follows what is stored; a URL wins when both are present. */
  let mode = $state<'url' | 'fields'>('fields');
  let smtpUrl = $state('');
  let host = $state('');
  let port = $state('');
  let user = $state('');
  let pass = $state('');
  let hasStoredPass = $state(false);
  let mailFrom = $state('');

  const applyView = (next: View): void => {
    view = next;
    const stored = next.stored;
    smtpUrl = stored?.smtp_url ?? '';
    host = stored?.host ?? '';
    port = stored?.port === null || stored?.port === undefined ? '' : String(stored.port);
    user = stored?.user ?? '';
    pass = '';
    hasStoredPass = stored?.has_pass ?? false;
    mailFrom = stored?.mail_from ?? '';
    mode = stored?.smtp_url ? 'url' : 'fields';
  };

  const load = async (): Promise<void> => {
    try {
      applyView(await api<View>('/api/v1/admin/settings/mail'));
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Mail settings are not available.');
    }
  };
  onMount(() => void load());

  const save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    busy = true;
    notice = '';
    error = '';
    try {
      const body: Record<string, unknown> =
        mode === 'url'
          ? { smtp_url: smtpUrl.trim() || null, mail_from: mailFrom.trim() || null }
          : {
              host: host.trim() || null,
              port: port.trim() ? Number(port) : null,
              user: user.trim() || null,
              mail_from: mailFrom.trim() || null
            };
      /* The password rides along only when typed; an untouched field keeps
         the stored secret. */
      if (mode === 'fields' && pass) body.pass = pass;
      applyView(await apiPut<View>('/api/v1/admin/settings/mail', body));
      notice = 'Saved. Send a test email to prove the transport.';
    } catch (caught) {
      error = messageFrom(caught, 'The settings could not be saved.');
    } finally {
      busy = false;
    }
  };

  const clear = async (): Promise<void> => {
    busy = true;
    notice = '';
    error = '';
    try {
      await apiDelete('/api/v1/admin/settings/mail');
      await load();
      notice = 'Cleared. Email now follows the environment.';
    } catch (caught) {
      error = messageFrom(caught, 'The settings could not be cleared.');
    } finally {
      busy = false;
    }
  };

  let testBusy = $state(false);
  let testResult = $state('');
  let testFailed = $state(false);
  const sendTest = async (): Promise<void> => {
    testBusy = true;
    testResult = '';
    testFailed = false;
    try {
      const result = await apiPost<{ sent: true; to: string }>('/api/v1/admin/system/test-email', {});
      testResult = `Sent to ${result.to}. Check that inbox.`;
    } catch (caught) {
      testFailed = true;
      testResult = messageFrom(caught, 'The test email could not be sent.');
    } finally {
      testBusy = false;
    }
  };

  let policyBusy = $state(false);
  const setPolicy = async (patch: { invites?: boolean; digests?: boolean }): Promise<void> => {
    policyBusy = true;
    try {
      applyView(await apiPut<View>('/api/v1/admin/settings/mail', { policy: patch }));
    } catch (caught) {
      error = messageFrom(caught, 'The setting could not be saved.');
    } finally {
      policyBusy = false;
    }
  };

  const SOURCE_LABEL: Record<string, string> = {
    settings: 'these settings',
    env: 'the server environment',
    none: 'nothing'
  };

  /* Provider presets: one press fills what the provider fixes and the hint
     says exactly which secret goes in the password field. Values are the
     providers' long-stable SMTP endpoints. */
  type Preset = {
    name: string;
    host: string;
    port: number;
    user: string | null;
    userPlaceholder?: string;
    hint: string;
  };
  const PRESETS: Preset[] = [
    {
      name: 'Resend',
      host: 'smtp.resend.com',
      port: 465,
      user: 'resend',
      hint: 'Password is your Resend API key.'
    },
    {
      name: 'Postmark',
      host: 'smtp.postmarkapp.com',
      port: 587,
      user: null,
      userPlaceholder: 'Server API token',
      hint: 'Username and password are both the Server API token.'
    },
    {
      name: 'SendGrid',
      host: 'smtp.sendgrid.net',
      port: 587,
      user: 'apikey',
      hint: 'Username is literally "apikey"; password is your SendGrid API key.'
    },
    {
      name: 'Mailgun',
      host: 'smtp.mailgun.org',
      port: 587,
      user: null,
      userPlaceholder: 'postmaster@your-domain',
      hint: 'Username is postmaster@ your sending domain; password is its SMTP password.'
    },
    {
      name: 'Amazon SES',
      host: 'email-smtp.us-east-1.amazonaws.com',
      port: 587,
      user: null,
      userPlaceholder: 'SMTP username',
      hint: 'Change the region in the host to yours; credentials are SES SMTP credentials, not your AWS keys.'
    },
    {
      name: 'Gmail',
      host: 'smtp.gmail.com',
      port: 587,
      user: null,
      userPlaceholder: 'you@gmail.com',
      hint: 'Password is an app password (Google account > Security), not your account password.'
    },
    {
      name: 'Fastmail',
      host: 'smtp.fastmail.com',
      port: 465,
      user: null,
      userPlaceholder: 'you@fastmail.com',
      hint: 'Password is an app password from Fastmail settings.'
    },
    {
      name: 'Brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      user: null,
      userPlaceholder: 'Your Brevo login email',
      hint: 'Password is an SMTP key from the Brevo dashboard, not your account password. 300 sends a day free.'
    },
    {
      name: 'SMTP2GO',
      host: 'mail.smtp2go.com',
      port: 587,
      user: null,
      userPlaceholder: 'SMTP username',
      hint: 'Credentials are an SMTP user created in the SMTP2GO dashboard. A thousand sends a month free.'
    },
    {
      name: 'Proton',
      host: 'smtp.protonmail.ch',
      port: 587,
      user: null,
      userPlaceholder: 'you@your-domain',
      hint: 'Password is an SMTP token (Settings, IMAP/SMTP, Generate token). Needs a paid plan with a custom domain; your mailbox password will not work.'
    },
    {
      name: 'Migadu',
      host: 'smtp.migadu.com',
      port: 465,
      user: null,
      userPlaceholder: 'you@your-domain',
      hint: 'Username is the full address; password is that mailbox password or an app password.'
    },
    {
      name: 'Custom',
      host: '',
      port: 587,
      user: null,
      userPlaceholder: '',
      hint: 'Port 587 with STARTTLS is the usual default; 465 means implicit TLS.'
    }
  ];
  let presetHint = $state('');
  let userPlaceholder = $state('');
  const applyPreset = (preset: Preset): void => {
    mode = 'fields';
    host = preset.host;
    port = String(preset.port);
    user = preset.user ?? '';
    userPlaceholder = preset.userPlaceholder ?? '';
    presetHint = preset.hint;
    notice = '';
    error = '';
  };
</script>

<svelte:head><title>Email | Onelight</title></svelte:head>

<main class="page">
  <h1>Email</h1>
  <p class="lede">
    Settings saved here apply immediately and take precedence over the server environment.
  </p>

  {#if view}
    <p class="status" class:warn={view.active.state !== 'ready'}>
      {#if view.active.state === 'ready'}
        Email is on, configured by {SOURCE_LABEL[view.active.source]}.
      {:else if view.active.state === 'error'}
        Email is broken{view.active.detail ? `: ${view.active.detail}` : '.'}
      {:else}
        Email is off.
      {/if}
      {#if view.active.state === 'ready'}
        <button type="button" class="quiet" onclick={() => void sendTest()} disabled={testBusy}>
          {testBusy ? 'Sending' : 'Send a test email'}
        </button>
      {/if}
    </p>
    {#if testResult}<p class:warn={testFailed} role="status">{testResult}</p>{/if}

    <form class="panel" onsubmit={save}>
      <div class="presets" role="group" aria-label="Provider presets">
        {#each PRESETS as preset (preset.name)}
          <button type="button" onclick={() => applyPreset(preset)}>{preset.name}</button>
        {/each}
      </div>
      {#if presetHint}<p class="presethint">{presetHint}</p>{/if}

      <div class="modes" role="group" aria-label="Configuration shape">
        <button type="button" aria-pressed={mode === 'fields'} onclick={() => { mode = 'fields'; }}>Host and port</button>
        <button type="button" aria-pressed={mode === 'url'} onclick={() => { mode = 'url'; }}>Connection URL</button>
      </div>

      {#if mode === 'url'}
        <label>SMTP URL
          <input bind:value={smtpUrl} placeholder="smtps://user:password@mail.example.com:465" autocomplete="off" />
        </label>
      {:else}
        <label>Host
          <input bind:value={host} placeholder="mail.example.com" autocomplete="off" />
        </label>
        <div class="row">
          <label>Port
            <input bind:value={port} placeholder="587" inputmode="numeric" autocomplete="off" />
          </label>
          <label>Username
            <input bind:value={user} placeholder={userPlaceholder} autocomplete="off" />
          </label>
          <label>Password
            <input type="password" bind:value={pass} placeholder={hasStoredPass ? 'Stored; type to replace' : ''} autocomplete="new-password" />
          </label>
        </div>
      {/if}
      <label>From address
        <input bind:value={mailFrom} placeholder="Onelight &lt;mail@example.com&gt;" autocomplete="off" />
      </label>

      {#if error}<p class="warn" role="alert">{error}</p>{/if}
      {#if notice}<p class="notice" role="status">{notice}</p>{/if}

      <div class="actions">
        <button type="submit" class="primary" disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
        {#if view.stored}
          <button type="button" class="quiet" onclick={() => void clear()} disabled={busy}>
            Remove and follow the environment
          </button>
        {/if}
      </div>
    </form>
    <section class="panel sends" aria-label="What sends">
      <h2>What sends</h2>
      <ul>
        <li>
          <span>Password resets and the test email</span>
          <span class="always">always, when email works</span>
        </li>
        <li>
          <label>
            <input
              type="checkbox"
              checked={view.policy.invites}
              disabled={policyBusy}
              onchange={(event) => void setPolicy({ invites: (event.currentTarget as HTMLInputElement).checked })}
            />
            Invitations, sent to the invitee when an admin invites them
          </label>
        </li>
        <li>
          <label>
            <input
              type="checkbox"
              checked={view.policy.digests}
              disabled={policyBusy}
              onchange={(event) => void setPolicy({ digests: (event.currentTarget as HTMLInputElement).checked })}
            />
            Notification digests, on each person's own schedule
          </label>
          <a class="quietlink" href="/settings/notifications">Your schedule</a>
        </li>
      </ul>
    </section>
  {:else if error}
    <p class="warn" role="alert">{error}</p>
  {:else}
    <p class="empty">Loading.</p>
  {/if}
</main>

<style>
  .page { padding: 44px 0 72px; color: var(--ink-text); font-size: var(--text-13); }
  h1 { margin: 0 0 8px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 36px); font-weight: 700; letter-spacing: -0.02em; }
  .lede { margin: 0 0 20px; color: var(--ink-text-dim); max-width: 560px; line-height: 1.5; }

  .status { display: flex; align-items: center; gap: 14px; margin: 0 0 18px; }

  .panel { background: var(--ink-100); border-radius: var(--radius); padding: 22px; max-width: 560px; display: grid; gap: 14px; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .presets button { border: 0; border-radius: var(--radius); background: var(--ink-000); color: var(--ink-text-dim); padding: 6px 11px; font-size: var(--text-12); }
  .presets button:hover { background: var(--ink-200); color: var(--ink-text); }
  .presethint { margin: 0; color: var(--ink-text-dim); font-size: var(--text-12); }

  .modes { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius); background: var(--ink-000); width: fit-content; }
  .modes button { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 5px 12px; font-size: var(--text-12); font-weight: 500; }
  .modes button[aria-pressed='true'] { background: var(--ink-300); color: #fff; }

  label { display: grid; gap: 5px; color: var(--ink-text-dim); }
  input { border: 0; border-radius: var(--radius); background: var(--ink-000); color: var(--ink-text); padding: 9px 12px; font-size: var(--text-13); }
  .row { display: grid; grid-template-columns: 90px 1fr 1fr; gap: 10px; }

  .actions { display: flex; align-items: center; gap: 12px; }
  .primary { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  .primary:hover { background: var(--accent-bright); }
  .primary:disabled { opacity: 0.5; }
  .quiet { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 7px 12px; font-size: var(--text-12); }
  .quiet:hover { background: var(--ink-300); }
  .quiet:disabled { opacity: 0.5; }

  .sends { margin-top: 16px; }
  .sends h2 { margin: 0 0 10px; font-size: var(--text-14); font-weight: 600; }
  .sends ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .sends li { display: flex; align-items: center; gap: 10px; color: var(--ink-text); }
  .sends label { display: flex; align-items: center; gap: 8px; color: var(--ink-text); cursor: pointer; }
  .sends .always { color: var(--ink-text-dim); font-size: var(--text-12); }
  .quietlink { color: var(--ink-text-dim); font-size: var(--text-12); }
  .quietlink:hover { color: var(--ink-text); }

  .warn { color: var(--warn); margin: 0; }
  .notice { color: var(--ink-text-dim); margin: 0; }
  .empty { color: var(--ink-text-dim); }
</style>
