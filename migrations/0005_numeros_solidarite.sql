-- Appliquer après 0004, une seule fois. Ne supprimer aucune table.
ALTER TABLE solidarity_motifs ADD COLUMN reference TEXT;
ALTER TABLE solidarity_contributions ADD COLUMN reference TEXT;
UPDATE solidarity_motifs SET reference='MOT-ANC-'+upper(substr(replace(id,'-',''),1,12)) WHERE reference IS NULL;
UPDATE solidarity_contributions SET reference='MVT-ANC-'+upper(substr(replace(id,'-',''),1,12)) WHERE reference IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_motif_reference ON solidarity_motifs(reference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_movement_reference ON solidarity_contributions(reference);
