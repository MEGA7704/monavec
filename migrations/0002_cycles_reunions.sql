-- À exécuter UNE SEULE FOIS après 0001_init.sql. Aucun effacement de données.
ALTER TABLE cycles ADD COLUMN duration_months INTEGER NOT NULL DEFAULT 12;
ALTER TABLE cycles ADD COLUMN end_date TEXT;
ALTER TABLE cycles ADD COLUMN frequency_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE cycles ADD COLUMN weekday INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycles ADD COLUMN absence_fine INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_cycle_per_org ON cycles(org_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_cycle_date ON meetings(cycle_id,meeting_date);
CREATE TABLE IF NOT EXISTS meeting_attendance(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,cycle_id TEXT NOT NULL,meeting_date TEXT NOT NULL,member_id TEXT NOT NULL,present INTEGER NOT NULL CHECK(present IN (0,1)),fine_amount INTEGER NOT NULL DEFAULT 0 CHECK(fine_amount>=0),fine_paid INTEGER NOT NULL DEFAULT 0 CHECK(fine_paid IN (0,1)),created_at INTEGER NOT NULL,UNIQUE(cycle_id,meeting_date,member_id),FOREIGN KEY(cycle_id) REFERENCES cycles(id),FOREIGN KEY(member_id) REFERENCES members(id));
CREATE INDEX IF NOT EXISTS idx_attendance_org_cycle ON meeting_attendance(org_id,cycle_id,meeting_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_one_member_meeting ON savings(meeting_id,member_id) WHERE meeting_id IS NOT NULL;
