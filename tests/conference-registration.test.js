const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { FakeBlogPool } = require('./helpers');
const apiModule = require('../api/index.js');

function findRoute(path, method = 'post') {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods[method];
  });
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirectStatus: undefined,
    redirectLocation: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    redirect(statusOrUrl, maybeUrl) {
      if (typeof maybeUrl === 'string') {
        this.redirectStatus = statusOrUrl;
        this.redirectLocation = maybeUrl;
      } else {
        this.redirectStatus = 302;
        this.redirectLocation = statusOrUrl;
      }
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('POST /api/conference-registration rifiuta nuove iscrizioni quando il form e chiuso', async (t) => {
  const calls = [];
  const originalOpen = process.env.CONFERENCE_REGISTRATION_OPEN;
  delete process.env.CONFERENCE_REGISTRATION_OPEN;
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  apiModule.__setConferenceRegistrationEmailSender(async (payload) => {
    calls.push(payload);
    return { success: true, provider: 'resend' };
  });
  t.after(() => {
    if (originalOpen === undefined) {
      delete process.env.CONFERENCE_REGISTRATION_OPEN;
    } else {
      process.env.CONFERENCE_REGISTRATION_OPEN = originalOpen;
    }
    apiModule.__setPool(null);
    apiModule.__setConferenceRegistrationEmailSender(null);
  });

  const layer = findRoute('/api/conference-registration', 'post');
  assert.ok(layer, 'route /api/conference-registration non trovata');

  const res = createRes();
  await layer.route.stack[0].handle({
    method: 'POST',
    url: '/api/conference-registration',
    body: {
      nome: 'Virgilio',
      cognome: 'Maretto',
      email: 'vmaretto@example.com',
      formStartedAt: Date.now() - 10000
    },
    headers: {}
  }, res);

  assert.equal(res.statusCode, 410);
  assert.equal(res.body, 'Registrazioni chiuse.');
  assert.equal(calls.length, 0);
  assert.equal(pool.conferenceRegistrations.length, 0);
});

test('POST /api/conference-registration invia le email e reindirizza alla conferma quando aperta', async (t) => {
  const calls = [];
  const originalOpen = process.env.CONFERENCE_REGISTRATION_OPEN;
  process.env.CONFERENCE_REGISTRATION_OPEN = 'true';
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  apiModule.__setConferenceRegistrationEmailSender(async (payload) => {
    calls.push(payload);
    return { success: true, provider: 'resend' };
  });
  t.after(() => {
    if (originalOpen === undefined) {
      delete process.env.CONFERENCE_REGISTRATION_OPEN;
    } else {
      process.env.CONFERENCE_REGISTRATION_OPEN = originalOpen;
    }
    apiModule.__setPool(null);
    apiModule.__setConferenceRegistrationEmailSender(null);
  });

  const layer = findRoute('/api/conference-registration', 'post');
  assert.ok(layer, 'route /api/conference-registration non trovata');

  const req = {
    method: 'POST',
    url: '/api/conference-registration',
    body: {
      nome: 'Virgilio',
      cognome: 'Maretto',
      email: 'vmaretto@example.com',
      telefono: '123456789',
      ente: 'UNITUS',
      ruolo: 'CEO',
      note: 'Test',
      formStartedAt: Date.now() - 10000
    },
    headers: {}
  };
  const res = createRes();

  await layer.route.stack[0].handle(req, res);

  assert.equal(res.redirectStatus, 303);
  assert.equal(res.redirectLocation, '/conferenza-26-maggio-2026.html?sent=1#grazie');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, 'maretto@carbonfarmingmaster.it');
  assert.equal(calls[1].to, 'vmaretto@example.com');
  assert.match(String(calls[0].subject), /Registrazione conferenza 26 maggio 2026/);
  assert.match(String(calls[1].subject), /Conferma registrazione conferenza 26 maggio 2026/);

  assert.equal(pool.conferenceRegistrations.length, 1);
  const tracking = pool.conferenceRegistrations[0];
  assert.equal(tracking.full_name, 'Virgilio Maretto');
  assert.equal(tracking.email, 'vmaretto@example.com');
  assert.equal(tracking.organizer_email_status, 'sent');
  assert.equal(tracking.confirmation_email_status, 'sent');
  assert.equal(tracking.overall_status, 'sent');
});

test('POST /api/conference-registration blocca invii honeypot quando aperta', async (t) => {
  const calls = [];
  const originalOpen = process.env.CONFERENCE_REGISTRATION_OPEN;
  process.env.CONFERENCE_REGISTRATION_OPEN = 'true';
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  apiModule.__setConferenceRegistrationEmailSender(async (payload) => {
    calls.push(payload);
    return { success: true, provider: 'resend' };
  });
  t.after(() => {
    if (originalOpen === undefined) {
      delete process.env.CONFERENCE_REGISTRATION_OPEN;
    } else {
      process.env.CONFERENCE_REGISTRATION_OPEN = originalOpen;
    }
    apiModule.__setPool(null);
    apiModule.__setConferenceRegistrationEmailSender(null);
  });

  const layer = findRoute('/api/conference-registration', 'post');
  assert.ok(layer, 'route /api/conference-registration non trovata');

  const res = createRes();
  await layer.route.stack[0].handle({
    method: 'POST',
    url: '/api/conference-registration',
    body: {
      nome: 'Spam',
      cognome: 'Bot',
      email: 'spam@example.com',
      website: 'https://spam.example',
      formStartedAt: Date.now() - 10000
    },
    headers: {}
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal(pool.conferenceRegistrations.length, 0);
});

async function buildConferenceXlsxBuffer() {
  const zip = new JSZip();
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Nome</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Cognome</t></is></c>
      <c r="C1" t="inlineStr"><is><t>Email</t></is></c>
      <c r="D1" t="inlineStr"><is><t>Telefono</t></is></c>
      <c r="E1" t="inlineStr"><is><t>Ente</t></is></c>
      <c r="F1" t="inlineStr"><is><t>Ruolo</t></is></c>
      <c r="G1" t="inlineStr"><is><t>Note</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Maria</t></is></c>
      <c r="B2" t="inlineStr"><is><t>Rossi</t></is></c>
      <c r="C2" t="inlineStr"><is><t>maria.rossi@example.com</t></is></c>
      <c r="D2" t="inlineStr"><is><t>3331112222</t></is></c>
      <c r="E2" t="inlineStr"><is><t>Universita</t></is></c>
      <c r="F2" t="inlineStr"><is><t>Ricercatrice</t></is></c>
      <c r="G2" t="inlineStr"><is><t>Importata da Excel</t></is></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>Virgilio</t></is></c>
      <c r="B3" t="inlineStr"><is><t>Maretto</t></is></c>
      <c r="C3" t="inlineStr"><is><t>vmaretto@example.com</t></is></c>
      <c r="D3" t="inlineStr"><is><t>123456789</t></is></c>
      <c r="E3" t="inlineStr"><is><t>UNITUS</t></is></c>
      <c r="F3" t="inlineStr"><is><t>CEO</t></is></c>
      <c r="G3" t="inlineStr"><is><t>Duplicata del tracking</t></is></c>
    </row>
  </sheetData>
</worksheet>`;
  zip.file('xl/worksheets/sheet1.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('POST /api/admin/conference-registrations/import-xlsx importa righe nuove e salta i duplicati', async (t) => {
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  t.after(() => {
    apiModule.__setPool(null);
  });

  pool.conferenceRegistrations.push({
    id: 'tracked-1',
    full_name: 'Virgilio Maretto',
    email: 'vmaretto@example.com',
    phone: '123456789',
    organization: 'UNITUS',
    role: 'CEO',
    note: 'Tracciata dal form',
    organizer_email_status: 'sent',
    organizer_email_provider: 'resend',
    organizer_email_error: null,
    organizer_email_sent_at: new Date().toISOString(),
    confirmation_email_status: 'sent',
    confirmation_email_provider: 'resend',
    confirmation_email_error: null,
    confirmation_email_sent_at: new Date().toISOString(),
    overall_status: 'sent',
    final_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const buffer = await buildConferenceXlsxBuffer();
  const layer = findRoute('/api/admin/conference-registrations/import-xlsx', 'post');
  assert.ok(layer, 'route /api/admin/conference-registrations/import-xlsx non trovata');

  const req = {
    method: 'POST',
    url: '/api/admin/conference-registrations/import-xlsx',
    file: {
      originalname: 'registrazioni.xlsx',
      buffer
    },
    headers: {}
  };
  const res = createRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 1);
  assert.equal(pool.conferenceRegistrationImports.length, 1);
  assert.equal(pool.conferenceRegistrationImports[0].email, 'maria.rossi@example.com');

  const listLayer = findRoute('/api/admin/conference-registrations', 'get');
  assert.ok(listLayer, 'route /api/admin/conference-registrations non trovata');
  const listRes = createRes();
  await listLayer.route.stack[listLayer.route.stack.length - 1].handle({ method: 'GET', url: '/api/admin/conference-registrations', query: { limit: '50' }, headers: {} }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.length, 2);
  assert.ok(listRes.body.some((row) => row.recordType === 'tracked'));
  assert.ok(listRes.body.some((row) => row.recordType === 'imported'));
});

test('DELETE /api/admin/conference-registrations/:recordType/:id elimina una registrazione', async (t) => {
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  t.after(() => {
    apiModule.__setPool(null);
  });

  pool.conferenceRegistrations.push({
    id: 'tracked-1',
    full_name: 'Bot Fake',
    email: 'bot@example.com',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const layer = findRoute('/api/admin/conference-registrations/:recordType/:id', 'delete');
  assert.ok(layer, 'route DELETE conference registrations non trovata');

  const res = createRes();
  await layer.route.stack[layer.route.stack.length - 1].handle({
    method: 'DELETE',
    url: '/api/admin/conference-registrations/tracked/tracked-1',
    params: { recordType: 'tracked', id: 'tracked-1' },
    headers: {}
  }, res);

  assert.equal(res.statusCode, 204);
  assert.equal(pool.conferenceRegistrations.length, 0);
});
