'use strict';

/**
 * ============================================================================
 *  MAIL — fixed subjects, escaped bodies, class caps, no secrets in logs (spec §9, A10, A20)
 * ============================================================================
 *
 *  Every email this install sends carries a bearer credential (a setup,
 *  invitation or reset link) or a security notice, to an address that — for
 *  setup and forgot-password — an ANONYMOUS caller chose. So:
 *
 *    - every interpolated value is HTML-escaped, and the subject is a constant
 *      no caller can influence (a name like `<a href=…>` must not become a
 *      phishing link inside our own message);
 *    - the plain-text part is always present, and there are no remote images;
 *    - anonymous-triggered sends may use only half of each cap, so strangers
 *      cannot spend the budget invitations and security notices need;
 *    - the link and its token never reach a log line;
 *    - `sendTemplatedEmail` NEVER throws and never rejects — several callers
 *      send from `setImmediate`, where a throw is an uncaught exception.
 *
 *  The SMTP transport is never contacted: `nodemailer.createTransport` is
 *  replaced before the mail module loads, and sends are stubbed at
 *  `smtp.client#sendRaw`.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_FROM = 'noreply@example.com';
process.env.APP_PUBLIC_URL = 'https://analytics.example.com';
process.env.EMAIL_MAX_PER_HOUR = '4';
process.env.EMAIL_MAX_PER_DAY = '100';
for (const key of ['TRUST_PROXY', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_PORT', 'SMTP_ALLOW_INSECURE']) {
    delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const nodemailer = require('nodemailer');

// ── Installed BEFORE the mail module loads, so an import-time transport would be seen ──
const CREATED_TRANSPORTS = [];
const REAL_CREATE_TRANSPORT = nodemailer.createTransport;
nodemailer.createTransport = (options) => {
    CREATED_TRANSPORTS.push(options);
    return {
        verify: async () => true,
        sendMail: async () => ({ accepted: ['someone@example.com'], rejected: [], messageId: '<fake@example.com>' })
    };
};

const SRC = path.resolve(__dirname, '..', 'src');
const MAIL = path.join(SRC, 'modules', 'mail');

const mailModule = require(MAIL);
const mailService = require(path.join(MAIL, 'services', 'mail.service.ts'));
const smtpClient = require(path.join(MAIL, 'clients', 'smtp.client.ts'));
const emailTemplateHelper = require(path.join(MAIL, 'helpers', 'emailTemplate.helper.ts'));
const mailCapHelper = require(path.join(MAIL, 'helpers', 'mailCap.helper.ts'));
const mailConstants = require(path.join(MAIL, 'constants', 'mail.constants.ts'));
const logger = require(path.join(SRC, 'core', 'logger.ts'));

const { EMAIL_TEMPLATES, EMAIL_SUBJECTS, MAIL_TRIGGERS, MAIL_SEND_STATUSES } = mailConstants;
const { buildEmail } = emailTemplateHelper;

const IMPORT_TIME_TRANSPORTS = CREATED_TRANSPORTS.length;

const NOW = new Date('2026-06-01T10:00:00.000Z');
const IN_30_MIN = new Date('2026-06-01T10:30:00.000Z');
const TOKEN = crypto.randomBytes(32).toString('base64url');
const LINK = `https://analytics.example.com/accept-invite#token=${TOKEN}`;
const SENDER = { user_id: 'a'.repeat(24) };

const HOSTILE = '<script>alert("x")</script> O\'Neil & "Co" <img src=https://evil.example/p.png>';

const STUBS = [];
const _stub = (target, key, value) => {
    STUBS.push({ target, key, original: target[key] });
    target[key] = value;
};

const LOGS = [];

test.beforeEach(() => {
    mailService.resetMailState();
    LOGS.length = 0;
    for (const level of ['customConsoleLog', 'customConsoleWarn', 'customConsoleError', 'customConsoleDebug']) {
        _stub(logger, level, (message, payload) => {
            let rendered = '';
            try {
                rendered = JSON.stringify(payload === undefined ? null : payload);
            } catch (error) {
                rendered = '<unserialisable>';
            }
            LOGS.push(`${message} ${rendered}`);
        });
    }
});

test.afterEach(() => {
    while (STUBS.length > 0) {
        const entry = STUBS.pop();
        entry.target[entry.key] = entry.original;
    }
});

test.after(() => {
    nodemailer.createTransport = REAL_CREATE_TRANSPORT;
});

/** Stubs `sendRaw`, recording what would have gone to the server. */
const _stubSendRaw = (answer) => {
    const sent = [];
    _stub(smtpClient, 'sendRaw', (message) => {
        sent.push(message);
        if (typeof answer === 'function') {
            return answer(message);
        }
        return Promise.resolve({ status: true, data: { message_id: '<m@example.com>' }, error: {}, msg: 'ok' });
    });
    return sent;
};

const _assertNoSecretLogged = () => {
    const joined = LOGS.join('\n');
    assert.equal(joined.includes(TOKEN), false, 'A log line carried the link token.');
    // A server that echoes the message back has its `token=` redacted; what may never appear is a
    // link that still carries a usable credential.
    assert.equal(/token=(?!\[redacted\])/.test(joined), false, 'A log line carried a usable link or token.');
};


/* ==========================================================================
 *  The templates (pure)
 * ========================================================================== */

test('templates: every interpolated value is HTML-escaped — tags, quotes, apostrophes, ampersands', () => {
    const built = buildEmail(EMAIL_TEMPLATES.INVITE, {
        now: NOW,
        expires_at: IN_30_MIN,
        link: `https://analytics.example.com/accept-invite#token=${TOKEN}"><script>alert(1)</script>`,
        inviter_name: HOSTILE,
        role_label: '"><svg onload=alert(1)>',
        public_url: 'https://analytics.example.com/"><b>'
    });
    assert.equal(/<script/i.test(built.html), false, 'A <script> survived into the HTML body.');
    assert.equal(/<img/i.test(built.html), false, 'An <img> survived into the HTML body.');
    assert.equal(/<svg/i.test(built.html), false);
    for (const breakout of ['"><script', '"><svg', '"><b>']) {
        assert.equal(built.html.includes(breakout), false, `An attribute breakout survived: ${breakout}`);
    }
    assert.ok(built.html.includes('&lt;script&gt;'));
    assert.ok(built.html.includes('&quot;'));
    assert.ok(built.html.includes('&#39;'));
    assert.ok(built.html.includes('&amp;'));
});

test('templates: subjects are the fixed constants, whatever the variables say', () => {
    const vars = {
        now: NOW,
        expires_at: IN_30_MIN,
        link: LINK,
        inviter_name: 'Evil Subject Injection\r\nBcc: victim@example.com',
        role_label: 'Admin',
        ip: '203.0.113.9',
        public_url: 'https://analytics.example.com'
    };
    for (const template of Object.values(EMAIL_TEMPLATES)) {
        const built = buildEmail(template, vars);
        assert.equal(built.subject, EMAIL_SUBJECTS[template]);
        assert.equal(/Evil|Bcc|\r|\n/.test(built.subject), false, `${template}: a variable reached the subject.`);
    }
    // And the constant itself carries nothing a caller wrote.
    for (const subject of Object.values(EMAIL_SUBJECTS)) {
        assert.equal(/[<>\r\n]/.test(subject), false);
    }
});

test('templates: a plain-text part always exists, carries the link where there is one, and every message says what to do if it was not you', () => {
    const vars = { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jordan', role_label: 'Analyst' };
    for (const template of Object.values(EMAIL_TEMPLATES)) {
        const built = buildEmail(template, vars);
        assert.equal(typeof built.text, 'string');
        assert.ok(built.text.length > 40, `${template} has no meaningful text part.`);
        assert.match(built.text, /ignore this email/i, `${template} lacks the "if this wasn't you" line.`);
        assert.equal(/<[a-z]/i.test(built.text), false, `${template}: the text part contains markup.`);
        if (template !== EMAIL_TEMPLATES.PASSWORD_CHANGED) {
            assert.ok(built.text.includes(LINK), `${template}: the text part must carry the link.`);
        } else {
            assert.equal(built.text.includes('#token='), false, 'A password-changed notice carries no link.');
        }
    }
});

test('templates: no remote content — no images, no external stylesheet, no script', () => {
    for (const template of Object.values(EMAIL_TEMPLATES)) {
        const built = buildEmail(template, { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jordan', role_label: 'Analyst' });
        assert.equal(/<img|<link|<script|<iframe|url\(/i.test(built.html), false, `${template} loads remote content.`);
        assert.equal(/\bsrc\s*=/i.test(built.html), false);
    }
});

test('templates: expiry is a duration plus an explicit UTC instant — never a locale string', () => {
    const built = buildEmail(EMAIL_TEMPLATES.PASSWORD_RESET, { now: NOW, expires_at: IN_30_MIN, link: 'https://analytics.example.com/reset-password#token=' + TOKEN });
    assert.match(built.text, /expires in 30 minutes/);
    assert.match(built.text, /2026-06-01T10:30:00Z \(UTC\)/);
    assert.equal(emailTemplateHelper.formatDuration(72 * 3600 * 1000), '3 days');
    assert.equal(emailTemplateHelper.formatDuration(90 * 60 * 1000), '1 hour 30 minutes');
    assert.equal(emailTemplateHelper.formatDuration(10 * 1000), 'less than a minute');
});

test('templates: the setup email never needs (or shows) a requester-supplied name; unknown templates and missing vars refuse', () => {
    const built = buildEmail(EMAIL_TEMPLATES.SETUP_VERIFY, { now: NOW, expires_at: IN_30_MIN, link: 'https://analytics.example.com/setup/verify#token=' + TOKEN });
    assert.ok(built.html.length > 0);
    assert.throws(() => buildEmail('WELCOME', { now: NOW }), TypeError);
    assert.throws(() => buildEmail(EMAIL_TEMPLATES.INVITE, { now: NOW, expires_at: IN_30_MIN, link: LINK }), /inviter_name/);
    assert.throws(() => buildEmail(EMAIL_TEMPLATES.PASSWORD_RESET, { now: NOW, expires_at: IN_30_MIN, link: 'javascript:alert(1)' }), /absolute http/);
    assert.throws(() => buildEmail(EMAIL_TEMPLATES.PASSWORD_RESET, { now: NOW, expires_at: IN_30_MIN, link: 'https://x.example/a b' }), /absolute http/);
    assert.throws(() => buildEmail(EMAIL_TEMPLATES.PASSWORD_CHANGED, { now: 'yesterday' }), /now/);
    // Control and bidi characters in a value are neutralised, not rendered.
    const bidi = buildEmail(EMAIL_TEMPLATES.INVITE, { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jor‮dan', role_label: 'Ana\u0000lyst' });
    assert.equal(/[‮\u0000]/.test(bidi.text + bidi.html), false);
});


/* ==========================================================================
 *  The transport
 * ========================================================================== */

test('transport: nothing is created at import; the first use creates ONE, TLS-required and certificate-verified', async () => {
    assert.equal(IMPORT_TIME_TRANSPORTS, 0, 'The mail module created a transport at import — CI loads every barrel with an empty env.');
    const checked = await smtpClient.verifyTransport();
    assert.equal(checked.status, true);
    await smtpClient.verifyTransport();
    assert.equal(CREATED_TRANSPORTS.length, 1, 'One transport, reused.');
    const options = CREATED_TRANSPORTS[0];
    assert.equal(options.host, 'smtp.example.com');
    assert.equal(options.port, 587, 'Not secure ⇒ the STARTTLS port by default.');
    assert.equal(options.secure, false);
    assert.equal(options.requireTLS, true, 'Without SMTP_ALLOW_INSECURE the STARTTLS upgrade is REQUIRED.');
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.tls.minVersion, 'TLSv1.2');
    assert.equal(options.auth, undefined, 'No SMTP_USER/PASS ⇒ no auth key at all (an auth-less relay).');
    assert.equal(options.logger, false, 'Nodemailer\'s protocol logger would write the AUTH exchange.');
    assert.ok(options.connectionTimeout > 0 && options.greetingTimeout > 0 && options.socketTimeout > 0);
});


/* ==========================================================================
 *  sendTemplatedEmail
 * ========================================================================== */

test('send: the server receives the fixed subject and both parts; the result says ACCEPTED, never "delivered"', async () => {
    const sent = _stubSendRaw();
    const result = await mailModule.sendTemplatedEmail(SENDER, {
        to: 'new@example.com',
        template: EMAIL_TEMPLATES.INVITE,
        vars: { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jordan', role_label: 'Analyst', ip: '203.0.113.9' },
        trigger: MAIL_TRIGGERS.ADMIN
    });
    assert.equal(result.status, true);
    assert.equal(result.data.accepted, true);
    assert.equal(result.data.status, MAIL_SEND_STATUSES.SENT);
    assert.equal(/deliver/i.test(result.msg), false, '"Sent" means accepted by the mail server — never claim delivery.');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, EMAIL_SUBJECTS.INVITE);
    assert.ok(sent[0].text && sent[0].html);
    // TRUST_PROXY is unset in this process, so the requesting IP is the proxy's and must not be printed.
    assert.equal(sent[0].text.includes('203.0.113.9'), false, 'An IP line appeared without TRUST_PROXY (A10).');
    _assertNoSecretLogged();
});

test('send: a stubbed logger never receives the token or the link — on success, on a server refusal, or on a refused link', async () => {
    _stubSendRaw(() => Promise.resolve({
        status: false,
        data: {},
        error: { code: 'EMESSAGE', responseCode: 550, response: `550 rejected message containing ${LINK} token=${TOKEN}` },
        msg: 'no'
    }));
    const refused = await mailModule.sendTemplatedEmail(SENDER, {
        to: 'new@example.com',
        template: EMAIL_TEMPLATES.INVITE,
        vars: { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jordan', role_label: 'Analyst' },
        trigger: MAIL_TRIGGERS.ADMIN
    });
    assert.equal(refused.data.status, MAIL_SEND_STATUSES.FAILED);

    // A link that did not come from APP_PUBLIC_URL is refused, and not echoed.
    const foreign = await mailModule.sendTemplatedEmail(SENDER, {
        to: 'new@example.com',
        template: EMAIL_TEMPLATES.PASSWORD_RESET,
        vars: { now: NOW, expires_at: IN_30_MIN, link: `https://analytics.example.com.evil.example/reset-password#token=${TOKEN}` },
        trigger: MAIL_TRIGGERS.ADMIN
    });
    assert.equal(foreign.data.status, MAIL_SEND_STATUSES.FAILED);

    // A message that cannot be built names the variable, not its value.
    await mailModule.sendTemplatedEmail(SENDER, {
        to: 'new@example.com',
        template: EMAIL_TEMPLATES.INVITE,
        vars: { now: NOW, expires_at: IN_30_MIN, link: LINK },
        trigger: MAIL_TRIGGERS.ADMIN
    });

    assert.ok(LOGS.length >= 3, 'The failure paths above must log something — otherwise this test proves nothing.');
    _assertNoSecretLogged();
});

test('send: caps by class — anonymous sends get half of each window; admin and security sends the full cap', async () => {
    const sent = _stubSendRaw();
    const _send = (to, trigger) => mailModule.sendTemplatedEmail(SENDER, {
        to: to,
        template: EMAIL_TEMPLATES.PASSWORD_CHANGED,
        vars: { now: NOW },
        trigger: trigger
    });
    // EMAIL_MAX_PER_HOUR=4 ⇒ anonymous share = 2.
    assert.equal((await _send('a1@example.com', MAIL_TRIGGERS.ANONYMOUS)).data.status, 'SENT');
    assert.equal((await _send('a2@example.com', MAIL_TRIGGERS.ANONYMOUS)).data.status, 'SENT');
    const third = await _send('a3@example.com', MAIL_TRIGGERS.ANONYMOUS);
    assert.equal(third.data.status, MAIL_SEND_STATUSES.CAP_REACHED, 'Strangers must not be able to spend more than half the budget.');
    assert.equal(third.data.accepted, false);

    assert.equal((await _send('b1@example.com', MAIL_TRIGGERS.ADMIN)).data.status, 'SENT', 'An invitation still goes out after anonymous sends hit their share.');
    assert.equal((await _send('b2@example.com', MAIL_TRIGGERS.SECURITY)).data.status, 'SENT');
    assert.equal((await _send('b3@example.com', MAIL_TRIGGERS.ADMIN)).data.status, MAIL_SEND_STATUSES.CAP_REACHED, 'The full hourly cap binds everyone.');
    assert.equal(sent.length, 4, 'A refused send never reaches the server.');
    assert.ok(LOGS.some((line) => /cap/i.test(line)), 'A cap refusal is logged with its reason.');
});

test('caps (pure): ≤ 10 per recipient per 24 h across all templates; entries older than a day do not count', () => {
    const now = Date.parse('2026-06-02T12:00:00.000Z');
    const limits = { max_per_hour: 1000, max_per_day: 1000, anonymous_share: 0.5, per_recipient_max_per_day: 10 };
    const recent = Array.from({ length: 10 }, (_, index) => ({ at_ms: now - (index + 1) * 60 * 60 * 1000 - 1, trigger: 'ADMIN', recipient: 'x@example.com' }));
    const decision = mailCapHelper.evaluateMailCaps(recent, { now_ms: now, trigger: 'SECURITY', recipient: 'x@example.com', limits: limits });
    assert.deepEqual(decision, { allowed: false, reason: 'RECIPIENT_DAILY_CAP' });
    assert.equal(mailCapHelper.evaluateMailCaps(recent, { now_ms: now, trigger: 'SECURITY', recipient: 'y@example.com', limits: limits }).allowed, true);

    const old = recent.map((entry) => Object.assign({}, entry, { at_ms: entry.at_ms - 25 * 60 * 60 * 1000 }));
    assert.equal(mailCapHelper.evaluateMailCaps(old, { now_ms: now, trigger: 'SECURITY', recipient: 'x@example.com', limits: limits }).allowed, true);
    assert.equal(mailCapHelper.pruneMailSendLog(old, now).length, 0);
});

test(' caps (pure): strangers get HALF of a recipient\'s daily cap, so a forgot-password flood cannot block that member\'s security notice or an admin-sent reset', () => {
    // The reproduced lockout: ten ANONYMOUS PASSWORD_RESET sends to one member refused every later
    // message to that address for a day — PASSWORD_CHANGED (SECURITY) and an admin reset included.
    const now = Date.parse('2026-06-02T12:00:00.000Z');
    const limits = { max_per_hour: 1000, max_per_day: 1000, anonymous_share: 0.5, per_recipient_max_per_day: 10 };
    const ledger = [];
    const outcomes = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const at = now - (10 - attempt) * 60 * 1000;
        const decision = mailCapHelper.evaluateMailCaps(ledger, { now_ms: at, trigger: 'ANONYMOUS', recipient: 'victim@example.com', limits: limits });
        outcomes.push(decision.allowed ? 'SENT' : decision.reason);
        if (decision.allowed) {
            ledger.push({ at_ms: at, trigger: 'ANONYMOUS', recipient: 'victim@example.com' });
        }
    }
    assert.deepEqual(outcomes, ['SENT', 'SENT', 'SENT', 'SENT', 'SENT', ...new Array(5).fill('RECIPIENT_ANONYMOUS_SHARE')]);

    for (const trigger of ['SECURITY', 'ADMIN']) {
        assert.deepEqual(
            mailCapHelper.evaluateMailCaps(ledger, { now_ms: now, trigger: trigger, recipient: 'victim@example.com', limits: limits }),
            { allowed: true, reason: null },
            `${trigger} mail to a member was refused because strangers had spent that member's cap`
        );
    }
    // The share is per recipient: another address is untouched by the first one's anonymous sends.
    assert.equal(mailCapHelper.evaluateMailCaps(ledger, { now_ms: now, trigger: 'ANONYMOUS', recipient: 'other@example.com', limits: limits }).allowed, true);

    // And the hard ceiling still binds every trigger once ten of ANY kind have gone out.
    const full = ledger.concat(Array.from({ length: 5 }, () => ({ at_ms: now - 1000, trigger: 'ADMIN', recipient: 'victim@example.com' })));
    assert.deepEqual(mailCapHelper.evaluateMailCaps(full, { now_ms: now, trigger: 'SECURITY', recipient: 'victim@example.com', limits: limits }), { allowed: false, reason: 'RECIPIENT_DAILY_CAP' });
});

test('send: NEVER throws or rejects — missing arguments, bad recipients, unknown templates, a throwing or rejecting transport', async () => {
    let calls = 0;
    _stubSendRaw(() => {
        calls += 1;
        if (calls % 2 === 1) {
            throw new Error('synchronous transport failure');
        }
        return Promise.reject(new Error('asynchronous transport failure'));
    });
    const vars = { now: NOW, expires_at: IN_30_MIN, link: LINK, inviter_name: 'Jordan', role_label: 'Analyst' };
    const attempts = [
        () => mailModule.sendTemplatedEmail(),
        () => mailModule.sendTemplatedEmail(SENDER),
        () => mailModule.sendTemplatedEmail(SENDER, null),
        () => mailModule.sendTemplatedEmail({}, { to: 'a@example.com', template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'a@example.com, b@example.com', template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: ['a@example.com'], template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'Name <a@example.com>', template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'a@example.com', template: 'NOT_A_TEMPLATE', vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'a@example.com', template: EMAIL_TEMPLATES.INVITE, vars: null, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'a@example.com', template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' }),
        () => mailModule.sendTemplatedEmail(SENDER, { to: 'b@example.com', template: EMAIL_TEMPLATES.INVITE, vars: vars, trigger: 'ADMIN' })
    ];
    for (const attempt of attempts) {
        let result;
        await assert.doesNotReject(async () => {
            result = await attempt();
        });
        assert.equal(result.status, false);
        assert.equal(result.data.accepted, false);
        assert.equal(typeof result.data.status, 'string');
    }
    assert.equal(calls, 2, 'Only the two well-formed messages reached the transport.');
});

test('send: an admin-facing deadline answers UNCONFIRMED — "the message may still arrive" — instead of hanging', async () => {
    _stubSendRaw(() => new Promise(() => {}));
    const started = Date.now();
    const result = await mailModule.sendTemplatedEmail(SENDER, {
        to: 'new@example.com',
        template: EMAIL_TEMPLATES.PASSWORD_CHANGED,
        vars: { now: NOW },
        trigger: MAIL_TRIGGERS.ADMIN,
        deadline_ms: 50
    });
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.data.status, MAIL_SEND_STATUSES.UNCONFIRMED);
    assert.match(result.msg, /may still arrive/);
});

test(' public check: only the connect-and-login check moves it — never a send (sends happen only for permitted setup addresses)', async () => {
    let verifyOk = true;
    let verifies = 0;
    _stub(smtpClient, 'verifyTransport', async () => {
        verifies += 1;
        return verifyOk ? { status: true, data: {}, error: {}, msg: 'ok' } : { status: false, data: {}, error: { code: 'EAUTH', responseCode: 535 }, msg: 'no' };
    });
    let sendOk = false;
    _stubSendRaw(() => Promise.resolve(sendOk
        ? { status: true, data: { message_id: '<m@example.com>' }, error: {}, msg: 'ok' }
        : { status: false, data: {}, error: { code: 'EAUTH', responseCode: 535 }, msg: 'no' }));
    const _send = () => mailModule.sendTemplatedEmail(SENDER, { to: 'owner@example.com', template: EMAIL_TEMPLATES.PASSWORD_CHANGED, vars: { now: NOW }, trigger: 'ANONYMOUS' });

    assert.equal(mailModule.getPublicMailCheck(), 'not_checked');
    await mailModule.verifyMailAtBoot();
    assert.equal(mailModule.getPublicMailCheck(), 'ok');

    // SMTP starts refusing: the send fails. The admin-facing status says so; the public one does not move.
    await _send();
    assert.equal(mailModule.getMailStatus().last_check, 'failed');
    assert.equal(mailModule.getPublicMailCheck(), 'ok', 'A send moved the public check — that is the setup-address oracle.');

    // A re-check (which every setup request triggers, whatever the address) does move it.
    verifyOk = false;
    await mailModule.recheckTransport();
    assert.equal(mailModule.getPublicMailCheck(), 'failed');

    // And the reverse: a send that succeeds does not flip a failed public check back.
    sendOk = true;
    await _send();
    assert.equal(mailModule.getMailStatus().last_check, 'ok');
    assert.equal(mailModule.getPublicMailCheck(), 'failed');

    // Coalesced: concurrent callers share one check, and none starts again inside the interval.
    mailService.resetMailState();
    verifies = 0;
    await Promise.all([mailModule.recheckTransport(), mailModule.recheckTransport(), mailModule.recheckTransport()]);
    await mailModule.recheckTransport();
    assert.equal(verifies, 1, `${verifies} SMTP checks for four requests — anonymous setup requests would be a connection amplifier.`);
});

test('status: reports ok / failed and a failure count — and never names the server or the account', async () => {
    assert.deepEqual(mailModule.getMailStatus(), { configured: true, last_check: 'not_checked', last_ok_at: null, consecutive_failures: 0 });

    let failing = true;
    _stubSendRaw(() => Promise.resolve(failing
        ? { status: false, data: {}, error: { code: 'ECONNECTION' }, msg: 'no' }
        : { status: true, data: { message_id: '<m@example.com>' }, error: {}, msg: 'ok' }));
    const _send = () => mailModule.sendTemplatedEmail(SENDER, { to: 'x@example.com', template: EMAIL_TEMPLATES.PASSWORD_CHANGED, vars: { now: NOW }, trigger: 'SECURITY' });
    await _send();
    await _send();
    let status = mailModule.getMailStatus();
    assert.equal(status.last_check, 'failed');
    assert.equal(status.consecutive_failures, 2);

    failing = false;
    await _send();
    status = mailModule.getMailStatus();
    assert.equal(status.last_check, 'ok');
    assert.equal(status.consecutive_failures, 0);
    assert.ok(status.last_ok_at instanceof Date);
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'consecutive_failures', 'last_check', 'last_ok_at']);
    assert.equal(JSON.stringify(status).includes('smtp.example.com'), false);
});
