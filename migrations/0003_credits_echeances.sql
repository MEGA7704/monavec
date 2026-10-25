-- Exécuter une seule fois après 0001 et 0002.
ALTER TABLE loans ADD COLUMN disbursed_at INTEGER;
ALTER TABLE loans ADD COLUMN repayment_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE loans ADD COLUMN penalty_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN penalty_frequency TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE loans ADD COLUMN penalty_accrued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN penalty_last_at INTEGER;
ALTER TABLE repayments ADD COLUMN penalty_amount INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_loans_org_status_due ON loans(org_id,status,due_at);
CREATE INDEX IF NOT EXISTS idx_repayments_loan_created ON repayments(loan_id,created_at);
