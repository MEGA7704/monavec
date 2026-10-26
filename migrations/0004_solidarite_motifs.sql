-- Migration à exécuter une seule fois dans D1 après les précédentes.
CREATE TABLE IF NOT EXISTS solidarity_motifs (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), cycle_id TEXT NOT NULL REFERENCES cycles(id),
 title TEXT NOT NULL, contribution INTEGER NOT NULL CHECK(contribution>0), destination TEXT NOT NULL CHECK(destination IN ('member','event')),
 beneficiary_id TEXT REFERENCES members(id), frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly')),
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
 withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn>=0), created_at INTEGER NOT NULL,
 CHECK(end_date>=start_date));
CREATE INDEX IF NOT EXISTS idx_solidarity_motifs_org ON solidarity_motifs(org_id,cycle_id,status);
CREATE TABLE IF NOT EXISTS solidarity_contributions (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),motif_id TEXT NOT NULL REFERENCES solidarity_motifs(id),
 member_id TEXT NOT NULL REFERENCES members(id), payment_date TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0),created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_solidarity_contributions_motif ON solidarity_contributions(org_id,motif_id,member_id);
