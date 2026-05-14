const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

function findPostRoute(path) {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods.post;
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
    }
  };
}

test('POST /api/conference-registration invia le email e reindirizza alla conferma', async () => {
  const calls = [];
  apiModule.__setConferenceRegistrationEmailSender(async (payload) => {
    calls.push(payload);
    return { success: true };
  });

  const layer = findPostRoute('/api/conference-registration');
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
      note: 'Test'
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
});
