const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDashboardGreeting,
  formatAttendanceGoalMessage,
  getAttendanceGoalData,
  resolveSelectedMasterName,
  selectUpcomingLessons
} = require('../learn/js/dashboard-utils.js');

test('formatDashboardGreeting omette il master se non selezionato', () => {
  const greeting = formatDashboardGreeting({
    firstName: 'Simone',
    lastName: 'Cargiani'
  }, '');

  assert.equal(greeting, 'Ciao Simone Cargiani');
});

test('formatDashboardGreeting include il master se selezionato', () => {
  const greeting = formatDashboardGreeting({
    firstName: 'Simone',
    lastName: 'Cargiani'
  }, 'Carbon Farming Master');

  assert.equal(greeting, 'Ciao Simone Cargiani — Carbon Farming Master');
});

test('resolveSelectedMasterName usa il corso selezionato quando disponibile', () => {
  const masterName = resolveSelectedMasterName(
    { firstName: 'Simone' },
    [
      { id: 'course-a', title: 'Master A' },
      { id: 'course-b', title: 'Master B' }
    ],
    'course-b'
  );

  assert.equal(masterName, 'Master B');
});

test('formatAttendanceGoalMessage mostra le ore mancanti sotto soglia', () => {
  const message = formatAttendanceGoalMessage({
    totalPlannedHours: 432,
    minimumInPersonAttendanceRatio: 0.7,
    inPersonHours: 250
  });

  assert.equal(message, "Mancano 53 ore per raggiungere l'obiettivo minimo del 70% in presenza");
});

test('formatAttendanceGoalMessage mostra il messaggio positivo a soglia raggiunta', () => {
  const message = formatAttendanceGoalMessage({
    totalPlannedHours: 432,
    minimumInPersonAttendanceRatio: 0.7,
    inPersonHours: 303
  });

  assert.equal(message, 'Obiettivo minimo del 70% in presenza raggiunto ✓');
});

test('getAttendanceGoalData tratta correttamente il superamento della soglia', () => {
  const goal = getAttendanceGoalData({
    totalPlannedHours: 432,
    minimumInPersonAttendanceRatio: 0.7,
    inPersonHours: 320
  });

  assert.equal(goal.targetHours, 303);
  assert.equal(goal.missingHours, 0);
});

test('selectUpcomingLessons restituisce le prossime due lezioni in ordine cronologico', () => {
  const lessons = selectUpcomingLessons([
    { id: 'late', startDatetime: '2026-04-25T09:00:00.000Z' },
    { id: 'past', startDatetime: '2026-04-18T09:00:00.000Z' },
    { id: 'soon', startDatetime: '2026-04-21T09:00:00.000Z' },
    { id: 'mid', startDatetime: '2026-04-22T09:00:00.000Z' }
  ], new Date('2026-04-20T10:00:00.000Z'), 2);

  assert.deepEqual(lessons.map((lesson) => lesson.id), ['soon', 'mid']);
});
