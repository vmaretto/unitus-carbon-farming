(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DashboardUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const DEFAULT_TOTAL_HOURS = 432;
  const DEFAULT_MIN_IN_PERSON_ATTENDANCE_RATIO = 0.7;

  function formatName(user) {
    return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || user?.email || '';
  }

  function normalizeAttendanceRatio(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MIN_IN_PERSON_ATTENDANCE_RATIO;
    if (parsed > 1) return parsed / 100;
    return parsed;
  }

  function formatPercentLabel(ratio) {
    const percent = normalizeAttendanceRatio(ratio) * 100;
    return Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, '');
  }

  function formatHourValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0';
    return numeric.toFixed(1).replace(/\.0$/, '');
  }

  function resolveSelectedMasterName(user, courses, selectedCourseId) {
    const directKeys = [
      'selectedCourseTitle',
      'selectedCourseName',
      'currentMasterTitle',
      'currentMasterName',
      'currentMaster'
    ];

    for (const key of directKeys) {
      const value = user?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }

    const resolvedCourseId = selectedCourseId || user?.selectedCourseId || user?.currentMasterId || user?.selectedEditionId;
    if (!resolvedCourseId || !Array.isArray(courses)) return '';

    const match = courses.find((course) => {
      return course?.id === resolvedCourseId || course?.editionId === resolvedCourseId;
    });

    return match?.title || match?.editionName || '';
  }

  function formatDashboardGreeting(user, selectedMasterName) {
    const name = formatName(user);
    if (!name) return 'Ciao';
    if (selectedMasterName) return `Ciao ${name} — ${selectedMasterName}`;
    return `Ciao ${name}`;
  }

  function getAttendanceGoalData(course) {
    const totalHours = Number(course?.totalPlannedHours) > 0 ? Number(course.totalPlannedHours) : DEFAULT_TOTAL_HOURS;
    const minimumRatio = normalizeAttendanceRatio(
      course?.minimumInPersonAttendanceRatio ??
      course?.minimumAttendanceRatio ??
      course?.minimumAttendancePercent
    );
    const inPersonHours = Number(course?.inPersonHours) || 0;
    const targetHours = Math.ceil(totalHours * minimumRatio);
    const missingHours = Math.max(0, targetHours - inPersonHours);

    return {
      totalHours,
      minimumRatio,
      minimumPercentLabel: formatPercentLabel(minimumRatio),
      inPersonHours,
      targetHours,
      missingHours,
      missingHoursLabel: formatHourValue(missingHours)
    };
  }

  function formatAttendanceGoalMessage(course) {
    const goal = getAttendanceGoalData(course);
    if (goal.missingHours <= 0) {
      return `Obiettivo minimo del ${goal.minimumPercentLabel}% in presenza raggiunto ✓`;
    }
    return `Mancano ${goal.missingHoursLabel} ore per raggiungere l'obiettivo minimo del ${goal.minimumPercentLabel}% in presenza`;
  }

  function selectUpcomingLessons(lessons, now, limit) {
    const referenceNow = now instanceof Date ? now : new Date(now || Date.now());
    const maxItems = Number.isFinite(limit) ? limit : 2;

    return (Array.isArray(lessons) ? lessons : [])
      .filter((lesson) => {
        if (!lesson?.startDatetime) return false;
        const start = new Date(lesson.startDatetime);
        return Number.isFinite(start.getTime()) && start >= referenceNow;
      })
      .sort((left, right) => new Date(left.startDatetime) - new Date(right.startDatetime))
      .slice(0, maxItems);
  }

  return {
    DEFAULT_TOTAL_HOURS,
    DEFAULT_MIN_IN_PERSON_ATTENDANCE_RATIO,
    formatName,
    resolveSelectedMasterName,
    formatDashboardGreeting,
    getAttendanceGoalData,
    formatAttendanceGoalMessage,
    selectUpcomingLessons
  };
});
