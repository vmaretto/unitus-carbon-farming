ALTER TABLE faculty
ADD COLUMN IF NOT EXISTS can_view_all_materials BOOLEAN DEFAULT false;
