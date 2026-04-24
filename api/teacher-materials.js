function buildTeacherLessonAccessQuery(teacherFacultyId, lessonId) {
  return {
    text: `SELECT l.id, l.teacher_id AS "teacherId", f.email AS "lessonTeacherEmail"
       FROM lessons l
       LEFT JOIN faculty f ON f.id = l.teacher_id
       WHERE l.id = $2
         AND (
           l.teacher_id = $1
           OR f.email = (SELECT email FROM faculty WHERE id = $1)
         )
       LIMIT 1`,
    values: [teacherFacultyId, lessonId]
  };
}

function buildMaterialsPendingInsertPayload({ teacherFacultyId, lessonId, url, fileOriginalName, fileMimeType, title, description }) {
  return {
    text: `INSERT INTO materials_pending
       (faculty_id, lesson_id, file_url, file_name, file_type, title, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
    values: [
      teacherFacultyId,
      lessonId,
      url,
      fileOriginalName,
      fileMimeType,
      title,
      description || null
    ]
  };
}

function getTeacherMaterialResourceTitle(item) {
  return item?.title || item?.fileName || 'Materiale docente';
}

module.exports = {
  buildTeacherLessonAccessQuery,
  buildMaterialsPendingInsertPayload,
  getTeacherMaterialResourceTitle
};
