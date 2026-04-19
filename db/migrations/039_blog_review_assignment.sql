ALTER TABLE blog_posts
ADD COLUMN IF NOT EXISTS reviewer_teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_blog_posts_reviewer_teacher_id
  ON blog_posts(reviewer_teacher_id);
