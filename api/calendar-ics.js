function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function formatUtcDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const iso = date.toISOString().replace(/[-:]/g, '');
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

function buildEventDescription(lesson) {
  const teacherName = lesson.teacherName || lesson.externalTeacherName || lesson.teacher || '';
  const parts = [];
  if (teacherName) parts.push(`Docente: ${teacherName}`);
  if (lesson.description) parts.push(String(lesson.description).trim());
  return parts.join('\n');
}

function buildCalendarFeed(lessons, options) {
  const calendarName = options?.calendarName || 'Master Carbon Farming - Calendario Lezioni';
  const prodId = options?.prodId || '-//Master Carbon Farming//Calendario Lezioni//IT';
  const rows = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`
  ];

  (Array.isArray(lessons) ? lessons : []).forEach((lesson) => {
    const start = new Date(lesson.startDatetime);
    if (!Number.isFinite(start.getTime())) return;

    const durationMinutes = Number(lesson.durationMinutes) || 0;
    const end = lesson.endDatetime ? new Date(lesson.endDatetime) : new Date(start.getTime() + (durationMinutes * 60000));
    const uid = `${lesson.id}@carbonfarmingmaster.it`;
    const description = buildEventDescription(lesson);

    rows.push('BEGIN:VEVENT');
    rows.push(`UID:${escapeIcsText(uid)}`);
    rows.push(`DTSTAMP:${formatUtcDateTime(new Date())}`);
    rows.push(`DTSTART:${formatUtcDateTime(start)}`);
    rows.push(`DTEND:${formatUtcDateTime(end)}`);
    rows.push(`SUMMARY:${escapeIcsText(lesson.title || 'Lezione')}`);
    if (description) rows.push(`DESCRIPTION:${escapeIcsText(description)}`);
    if (lesson.locationPhysical) rows.push(`LOCATION:${escapeIcsText(lesson.locationPhysical)}`);
    rows.push(`STATUS:${String(lesson.status || 'CONFIRMED').toUpperCase()}`);
    rows.push('END:VEVENT');
  });

  rows.push('END:VCALENDAR');
  return `${rows.join('\r\n')}\r\n`;
}

module.exports = {
  escapeIcsText,
  formatUtcDateTime,
  buildCalendarFeed
};
