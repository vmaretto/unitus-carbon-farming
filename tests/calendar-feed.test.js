const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCalendarFeed } = require('../api/calendar-ics');
const apiModule = require('../api/index.js');

class FakeCalendarPool {
  async query(sql) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM lessons l LEFT JOIN faculty f ON f.id = l.teacher_id')) {
      return {
        rows: [
          {
            id: 'lesson-1',
            title: 'Seminario introduttivo',
            description: 'Panoramica del modulo',
            startDatetime: '2026-04-17T12:00:00.000Z',
            endDatetime: '2026-04-17T17:00:00.000Z',
            durationMinutes: 300,
            locationPhysical: 'Via IV Novembre 144',
            teacherName: 'Mario Rossi',
            status: 'confirmed'
          }
        ]
      };
    }

    throw new Error(`Unsupported query in FakeCalendarPool: ${normalized}`);
  }
}

test('buildCalendarFeed genera un VCALENDAR valido con VEVENT completi', () => {
  const ics = buildCalendarFeed([
    {
      id: 'lesson-1',
      title: 'Titolo lezione',
      description: 'Descrizione',
      startDatetime: '2026-04-17T12:00:00.000Z',
      endDatetime: '2026-04-17T17:00:00.000Z',
      durationMinutes: 300,
      locationPhysical: 'Via IV Novembre 144',
      teacherName: 'Mario Rossi',
      status: 'confirmed'
    }
  ]);

  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /UID:lesson-1@carbonfarmingmaster\.it/);
  assert.match(ics, /DTSTART:20260417T120000Z/);
  assert.match(ics, /DTEND:20260417T170000Z/);
  assert.match(ics, /SUMMARY:Titolo lezione/);
});

test('GET /api/calendar/feed.ics risponde con text/calendar e almeno un VEVENT', async () => {
  apiModule.__setPool(new FakeCalendarPool());

  const layer = apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === '/api/calendar/feed.ics' && entry.route.methods.get;
  });

  assert.ok(layer, 'route /api/calendar/feed.ics non trovata');

  const req = { method: 'GET', url: '/api/calendar/feed.ics', headers: {} };
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.setHeader('content-type', 'application/json');
      this.body = JSON.stringify(payload);
      return this;
    },
    send(payload) {
      this.body = String(payload);
      return this;
    }
  };

  await layer.route.stack[0].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /^text\/calendar; charset=utf-8/i);
  assert.equal(res.headers['cache-control'], 'public, max-age=3600');
  assert.match(res.body, /BEGIN:VEVENT/);
  assert.match(res.body, /UID:lesson-1@carbonfarmingmaster\.it/);
  assert.match(res.body, /SUMMARY:Seminario introduttivo/);
});

test('i pulsanti ICS e Google Calendar sono presenti nei calendari studente e docente', () => {
  const studentCalendar = fs.readFileSync(path.join(__dirname, '..', 'learn', 'calendar.html'), 'utf8');
  const teacherCalendar = fs.readFileSync(path.join(__dirname, '..', 'teachers', 'index.html'), 'utf8');
  const googleUrl = 'https://calendar.google.com/calendar/r?cid=webcal://unitus.carbonfarmingmaster.it/api/calendar/feed.ics';

  assert.match(studentCalendar, /\/api\/calendar\/feed\.ics/);
  assert.match(studentCalendar, /📥 Esporta \.ics/);
  assert.ok(studentCalendar.includes(googleUrl));

  assert.match(teacherCalendar, /\/api\/calendar\/feed\.ics/);
  assert.match(teacherCalendar, /📥 Esporta \.ics/);
  assert.ok(teacherCalendar.includes(googleUrl));
});
